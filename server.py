"""同屏 Lite: one screen, group voice; the server never receives media."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from collections import OrderedDict, deque
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import WSMsgType, web

ROOT = Path(__file__).parent / "public"
ROOM_ID = re.compile(r"^[a-z0-9]{12}$")
ASSETS = {"app.js", "rtc.js", "audio-meter.js", "styles.css", "favicon.svg",
          "app.webmanifest", "sw.js", "icon-192.png", "icon-512.png"}
SERVICE_KEY = web.AppKey('service', object)


def integer(name: str, default: int, minimum: int, maximum: int) -> int:
    value = int(os.getenv(name, str(default)))
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


@dataclass
class Settings:
    public_origin: str = ""
    access_key: str = ""
    stun_urls: tuple[str, ...] = ("stun:stun.cloudflare.com:3478",)
    turn_urls: tuple[str, ...] = ()
    turn_secret: str = ""
    relay_only: bool = False
    room_ttl: int = 21600
    idle_ttl: int = 1800
    max_rooms: int = 200
    max_connections: int = 450
    max_participants: int = 6
    # Only trust forwarded IPs when direct requests come from this proxy.
    trusted_proxies: tuple[str, ...] = ()

    @classmethod
    def from_env(cls):
        split = lambda name, default="": tuple(x.strip() for x in os.getenv(name, default).split(",") if x.strip())
        origin = os.getenv("PUBLIC_ORIGIN", "").rstrip("/")
        if origin:
            parsed = urlsplit(origin)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.path or parsed.query or parsed.fragment or parsed.username:
                raise ValueError("PUBLIC_ORIGIN must be an origin such as https://share.example.com")
        turn_urls = split("TURN_URLS")
        turn_secret = os.getenv("TURN_SECRET", "")
        relay_only = os.getenv("RELAY_ONLY", "false").lower() == "true"
        if bool(turn_urls) != bool(turn_secret) or (relay_only and not turn_urls):
            raise ValueError("TURN_URLS and TURN_SECRET must be configured together; relay-only needs TURN")
        stun_urls = split("STUN_URLS", "stun:stun.cloudflare.com:3478")
        if any(not u.startswith(("stun:", "stuns:")) for u in stun_urls):
            raise ValueError("STUN_URLS must contain stun:/stuns: URLs")
        if any(not u.startswith(("turn:", "turns:")) for u in turn_urls):
            raise ValueError("TURN_URLS must contain turn:/turns: URLs")
        return cls(
            public_origin=origin, access_key=os.getenv("ACCESS_KEY", ""),
            stun_urls=stun_urls, turn_urls=turn_urls, turn_secret=turn_secret,
            relay_only=relay_only, room_ttl=integer("ROOM_TTL_SECONDS", 21600, 60, 86400),
            idle_ttl=integer("IDLE_TTL_SECONDS", 1800, 30, 86400),
            max_rooms=integer("MAX_ROOMS", 200, 1, 10000),
            max_connections=integer("MAX_CONNECTIONS", 450, 2, 20000),
            max_participants=integer("MAX_PARTICIPANTS", 6, 2, 16),
            trusted_proxies=split("TRUSTED_PROXIES"),
        )


@dataclass
class Peer:
    id: str
    name: str
    ws: web.WebSocketResponse
    mic: bool = False
    sharing: bool = False
    system_audio: bool = False

    def public(self):
        return {"id": self.id, "name": self.name, "mic": self.mic,
                "sharing": self.sharing, "systemAudio": self.system_audio}


@dataclass
class Room:
    id: str
    key_hash: bytes
    created: float
    last_empty: float
    peers: dict[str, Peer] = field(default_factory=dict)
    share_owner: str | None = None
    epoch: int = 0


class RateLimiter:
    """Bounded in-memory windows: entries expire; untrusted IPs cannot grow forever."""
    def __init__(self, maximum_keys=4096):
        self.windows = OrderedDict()
        self.maximum_keys = maximum_keys

    def allow(self, key, limit, seconds):
        now = time.monotonic()
        window = self.windows.pop(key, deque())
        while window and window[0] <= now - seconds:
            window.popleft()
        allowed = len(window) < limit
        if allowed:
            window.append(now)
        self.windows[key] = window
        while len(self.windows) > self.maximum_keys:
            self.windows.popitem(last=False)
        return allowed


class Service:
    def __init__(self, settings):
        self.settings = settings
        self.rooms = {}
        self.sockets = set()
        self.limiter = RateLimiter()

    def ip(self, request):
        if request.remote in self.settings.trusted_proxies:
            # The deployment proxy OVERWRITES this header. It is never trusted by default.
            return request.headers.get("X-Real-IP", request.remote or "unknown")[:64]
        return request.remote or "unknown"

    def origin_allowed(self, request):
        origin = request.headers.get("Origin")
        expected = self.settings.public_origin or f"{request.scheme}://{request.host}"
        return origin == expected

    def ice(self, peer_id):
        servers = []
        if self.settings.stun_urls:
            servers.append({"urls": list(self.settings.stun_urls)})
        if self.settings.turn_urls:
            username = f"{int(time.time()) + self.settings.room_ttl + 600}:{peer_id}"
            credential = base64.b64encode(hmac.new(
                self.settings.turn_secret.encode(), username.encode(), hashlib.sha1).digest()).decode()
            servers.append({"urls": list(self.settings.turn_urls), "username": username, "credential": credential})
        return {"iceServers": servers, "iceTransportPolicy": "relay" if self.settings.relay_only else "all"}

    def expire_empty(self):
        now = time.time()
        for id, room in list(self.rooms.items()):
            if not room.peers and (now - room.created >= self.settings.room_ttl or now - room.last_empty >= self.settings.idle_ttl):
                self.rooms.pop(id, None)

    async def broadcast(self, room, payload, exclude=None):
        for peer in list(room.peers.values()):
            if peer.id != exclude and not peer.ws.closed:
                with suppress(ConnectionError, RuntimeError):
                    await peer.ws.send_json(payload)

    async def create_room(self, request):
        if not self.origin_allowed(request):
            return web.json_response({"error": "来源不被允许"}, status=403)
        if not self.limiter.allow(("create", self.ip(request)), 12, 60):
            return web.json_response({"error": "创建太频繁，请稍后重试"}, status=429)
        try:
            data = await request.json()
        except (ValueError, web.HTTPException):
            return web.json_response({"error": "请求格式不正确"}, status=400)
        if not isinstance(data, dict):
            return web.json_response({"error": "请求格式不正确"}, status=400)
        supplied = data.get("accessKey", "")
        if not isinstance(supplied, str) or len(supplied) > 256:
            return web.json_response({"error": "访问口令不正确"}, status=403)
        if self.settings.access_key and not secrets.compare_digest(supplied, self.settings.access_key):
            return web.json_response({"error": "访问口令不正确"}, status=403)
        self.expire_empty()
        if len(self.rooms) >= self.settings.max_rooms:
            return web.json_response({"error": "房间已满，请稍后重试"}, status=503)
        alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
        id = "".join(secrets.choice(alphabet) for _ in range(12))
        while id in self.rooms:
            id = "".join(secrets.choice(alphabet) for _ in range(12))
        key = secrets.token_urlsafe(32)
        now = time.time()
        self.rooms[id] = Room(id, hashlib.sha256(key.encode()).digest(), now, now)
        return web.json_response({"roomId": id, "key": key, "expiresAt": int(now + self.settings.room_ttl)}, status=201)

    async def socket(self, request):
        if not self.origin_allowed(request):
            raise web.HTTPForbidden(text="Origin rejected")
        if len(self.sockets) >= self.settings.max_connections or not self.limiter.allow(("connect", self.ip(request)), 120, 60):
            raise web.HTTPTooManyRequests(text="Try again later")
        ws = web.WebSocketResponse(heartbeat=15, max_msg_size=70000, receive_timeout=90)
        await ws.prepare(request)
        self.sockets.add(ws)
        room = peer = None
        messages = deque()
        try:
            # Room secrets travel in the first frame, never in access-log URLs.
            hello = await asyncio.wait_for(ws.receive_json(), timeout=8)
            if not isinstance(hello, dict) or hello.get("type") != "join":
                await ws.send_json({"type": "error", "code": "bad_join", "message": "加入请求无效"})
                return ws
            id, key, name = hello.get("roomId"), hello.get("key"), hello.get("name", "访客")
            if not isinstance(id, str) or not isinstance(key, str) or not ROOM_ID.fullmatch(id) or not 32 <= len(key) <= 80:
                await ws.send_json({"type": "error", "code": "bad_room", "message": "邀请链接无效或房间已过期"})
                return ws
            self.expire_empty()
            room = self.rooms.get(id)
            if not room or time.time() - room.created >= self.settings.room_ttl or not secrets.compare_digest(room.key_hash, hashlib.sha256(key.encode()).digest()):
                room = None
                await ws.send_json({"type": "error", "code": "bad_room", "message": "邀请链接无效或房间已过期"})
                return ws
            if len(room.peers) >= self.settings.max_participants:
                room = None
                await ws.send_json({"type": "error", "code": "room_full", "message": "房间人数已满，请等待空位"})
                return ws
            if not isinstance(name, str):
                name = "访客"
            name = "".join(c for c in name if c.isprintable()).strip()[:24] or "访客"
            peer = Peer(secrets.token_hex(8), name, ws)
            # No await between occupancy check and insertion: concurrent joins cannot overfill.
            room.peers[peer.id] = peer
            room.epoch += 1
            others = [p.public() for p in room.peers.values() if p.id != peer.id]
            await ws.send_json({"type": "joined", "selfId": peer.id, "peers": others,
                                "epoch": room.epoch, "ice": self.ice(peer.id),
                                "expiresAt": int(room.created + self.settings.room_ttl)})
            await self.broadcast(room, {"type": "peer-joined", "peer": peer.public(), "epoch": room.epoch}, exclude=peer.id)
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    break
                now = time.monotonic()
                while messages and messages[0] < now - 1:
                    messages.popleft()
                if len(messages) >= 120:
                    await ws.close(code=1008, message=b"Rate limit")
                    break
                messages.append(now)
                try:
                    data = json.loads(msg.data)
                except ValueError:
                    await ws.close(code=1008, message=b"Invalid JSON")
                    break
                if not isinstance(data, dict):
                    await ws.close(code=1008, message=b"Invalid message")
                    break
                await self.message(room, peer, data)
        except (asyncio.TimeoutError, ValueError, TypeError, ConnectionError):
            pass
        finally:
            self.sockets.discard(ws)
            if room and peer and room.peers.get(peer.id) is peer:
                room.peers.pop(peer.id)
                if room.share_owner == peer.id:
                    room.share_owner = None
                room.epoch += 1
                if not room.peers:
                    room.last_empty = time.time()
                await self.broadcast(room, {"type": "peer-left", "id": peer.id, "epoch": room.epoch})
            await ws.close()
        return ws

    async def message(self, room, peer, data):
        type = data.get("type")
        if type == "signal":
            target_id = data.get("to")
            if not isinstance(target_id, str) or target_id == peer.id or target_id not in room.peers:
                return
            signal = data.get("data")
            if not isinstance(signal, dict):
                return
            description = signal.get("description")
            candidate = signal.get("candidate")
            if description is not None:
                if not isinstance(description, dict) or description.get("type") not in {"offer", "answer"} or not isinstance(description.get("sdp"), str) or len(description["sdp"]) > 60000:
                    return
                signal = {"description": {"type": description["type"], "sdp": description["sdp"]}}
            elif candidate is not None:
                if not isinstance(candidate, dict) or not isinstance(candidate.get("candidate"), str) or len(candidate["candidate"]) > 4096:
                    return
                signal = {"candidate": {k: candidate[k] for k in ("candidate", "sdpMid", "sdpMLineIndex", "usernameFragment") if k in candidate}}
            elif signal.get("restart") is True:
                signal = {"restart": True}
            else:
                return
            # Only a member of this room can be addressed. Existing pair sessions
            # remain valid when another participant joins; peer IDs fence reconnects.
            target = room.peers.get(target_id)
            if target and not target.ws.closed:
                with suppress(ConnectionError, RuntimeError):
                    await target.ws.send_json({"type": "signal", "from": peer.id, "data": signal})
        elif type == "state":
            peer.mic = data.get("mic") is True
            peer.sharing = room.share_owner == peer.id and data.get("sharing") is True
            peer.system_audio = peer.sharing and data.get("systemAudio") is True
            await self.broadcast(room, {"type": "peer-state", "peer": peer.public(), "epoch": room.epoch}, exclude=peer.id)
        elif type == "share-request":
            granted = room.share_owner in {None, peer.id}
            if granted:
                room.share_owner = peer.id
                peer.sharing = True
                await self.broadcast(room, {"type": "peer-state", "peer": peer.public(), "epoch": room.epoch}, exclude=peer.id)
            await peer.ws.send_json({"type": "share-result", "requestId": str(data.get("requestId", ""))[:64], "granted": granted})
        elif type == "share-stop":
            if room.share_owner == peer.id:
                room.share_owner = None
            peer.sharing = peer.system_audio = False
            await self.broadcast(room, {"type": "peer-state", "peer": peer.public(), "epoch": room.epoch}, exclude=peer.id)
        elif type == "ice-refresh":
            await peer.ws.send_json({"type": "ice-config", "ice": self.ice(peer.id)})

    async def lifecycle(self, app):
        async def cleanup():
            while True:
                await asyncio.sleep(15)
                self.expire_empty()
                for room in list(self.rooms.values()):
                    if time.time() - room.created >= self.settings.room_ttl:
                        await self.broadcast(room, {"type": "error", "code": "expired", "message": "房间已到期，请创建新房间"})
                        for peer in list(room.peers.values()):
                            await peer.ws.close(code=1000, message=b"Room expired")
                        self.rooms.pop(room.id, None)
        task = asyncio.create_task(cleanup())
        yield
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        await asyncio.gather(*(ws.close(code=1001, message=b"Server shutdown") for ws in list(self.sockets)), return_exceptions=True)


@web.middleware
async def headers(request, handler):
    try:
        response = await handler(request)
    except web.HTTPException as exc:
        response = web.Response(status=exc.status, text=exc.text, headers=exc.headers)
    if not response.prepared:
        response.headers.update({
            "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-store", "X-Frame-Options": "DENY",
            "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
            "Permissions-Policy": "camera=(), microphone=(self), display-capture=(self)",
        })
    return response


def create_app(settings=None):
    settings = settings or Settings.from_env()
    service = Service(settings)
    app = web.Application(middlewares=[headers], client_max_size=8192)
    app[SERVICE_KEY] = service
    app.cleanup_ctx.append(service.lifecycle)

    async def config(request):
        return web.json_response({"name": "同屏 Lite", "version": "1.1.1", "maxParticipants": settings.max_participants,
                                  "accessKeyRequired": bool(settings.access_key), "turnConfigured": bool(settings.turn_urls)})

    async def health(request):
        return web.json_response({"status": "ok", "version": "1.1.1"})

    async def index(request):
        if "id" in request.match_info and not ROOM_ID.fullmatch(request.match_info["id"]):
            raise web.HTTPNotFound()
        return web.FileResponse(ROOT / "index.html")

    async def asset(request):
        name = request.match_info["name"]
        if name not in ASSETS:
            raise web.HTTPNotFound()
        return web.FileResponse(ROOT / name)

    app.router.add_get("/healthz", health)
    app.router.add_get("/api/config", config)
    app.router.add_post("/api/rooms", service.create_room)
    app.router.add_get("/ws", service.socket)
    app.router.add_get("/", index)
    app.router.add_get("/r/{id}", index)
    app.router.add_get("/{name}", asset)
    return app


if __name__ == "__main__":
    # No access logs: neither room paths nor SDP/IP-bearing frames are written to disk.
    web.run_app(create_app(), host=os.getenv("HOST", "127.0.0.1"),
                port=integer("PORT", 8080, 1, 65535), access_log=None)
