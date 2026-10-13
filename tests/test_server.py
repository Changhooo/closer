import asyncio
import base64
import hashlib
import hmac
import json
import time
import unittest

from aiohttp import ClientSession, WSServerHandshakeError
from aiohttp.test_utils import TestClient, TestServer

from server import RateLimiter, Settings, SERVICE_KEY, create_app


class ServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.settings = Settings(stun_urls=(), max_participants=6)
        self.app = create_app(self.settings)
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()
        self.origin = str(self.client.make_url('/')).rstrip('/')
        self.headers = {'Origin': self.origin}
        self.sockets = []

    async def asyncTearDown(self):
        await asyncio.gather(*(socket.close() for socket in self.sockets))
        await self.client.close()

    async def room(self, **kwargs):
        response = await self.client.post('/api/rooms', headers=self.headers, json=kwargs)
        self.assertEqual(response.status, 201)
        return await response.json()

    async def join(self, room, name='访客'):
        ws = await self.client.ws_connect('/ws', headers=self.headers)
        self.sockets.append(ws)
        await ws.send_json({'type': 'join', **room, 'name': name})
        result = await ws.receive_json(timeout=2)
        return ws, result

    async def next_type(self, ws, type, timeout=2):
        async def receive():
            while True:
                message = await ws.receive_json()
                if message.get('type') == type:
                    return message
        return await asyncio.wait_for(receive(), timeout)

    async def test_static_and_headers_and_no_source_disclosure(self):
        response = await self.client.get('/')
        self.assertEqual(response.status, 200)
        self.assertIn('一块屏幕', await response.text())
        self.assertIn("script-src 'self'", response.headers['Content-Security-Policy'])
        self.assertEqual(response.headers['Referrer-Policy'], 'no-referrer')
        for path in ['/server.py', '/.env', '/LICENSE', '/r/not-a-valid-id']:
            with self.subTest(path=path):
                self.assertEqual((await self.client.get(path)).status, 404)
        config = await (await self.client.get('/api/config')).json()
        self.assertEqual(config['maxParticipants'], 6)
        self.assertNotIn('iceServers', config)

    async def test_origin_checks_http_and_websocket(self):
        response = await self.client.post('/api/rooms', headers={'Origin': 'https://evil.example'}, json={})
        self.assertEqual(response.status, 403)
        with self.assertRaises(WSServerHandshakeError) as error:
            await self.client.ws_connect('/ws', headers={'Origin': 'https://evil.example'})
        self.assertEqual(error.exception.status, 403)

    async def test_access_key(self):
        self.settings.access_key = 'test-only-key'
        response = await self.client.post('/api/rooms', headers=self.headers, json={})
        self.assertEqual(response.status, 403)
        room = await self.room(accessKey='test-only-key')
        _, joined = await self.join(room)
        self.assertEqual(joined['type'], 'joined')

    async def test_secret_is_required_and_hashed(self):
        room = await self.room()
        self.assertNotIn(room['key'], repr(self.app[SERVICE_KEY].rooms))
        _, denied = await self.join({**room, 'key': 'a' * 43})
        self.assertEqual(denied['code'], 'bad_room')

    async def test_six_members_and_seventh_rejected(self):
        room = await self.room()
        for number in range(6):
            _, joined = await self.join(room, str(number))
            self.assertEqual(joined['type'], 'joined')
            self.assertEqual(len(joined['peers']), number)
        _, denied = await self.join(room, '第七人')
        self.assertEqual(denied['code'], 'room_full')
        self.assertEqual(len(self.app[SERVICE_KEY].rooms[room['roomId']].peers), 6)

    async def test_simultaneous_sharing_has_one_winner_and_handoff(self):
        room = await self.room()
        a, ja = await self.join(room, '甲')
        b, jb = await self.join(room, '乙')
        c, jc = await self.join(room, '丙')
        await asyncio.gather(a.send_json({'type': 'share-request', 'requestId': 'a'}), b.send_json({'type': 'share-request', 'requestId': 'b'}))
        ra, rb = await asyncio.gather(self.next_type(a, 'share-result'), self.next_type(b, 'share-result'))
        self.assertEqual(sum([ra['granted'], rb['granted']]), 1)
        winner = a if ra['granted'] else b
        loser = b if ra['granted'] else a
        await winner.send_json({'type': 'share-stop'})
        await loser.send_json({'type': 'share-request', 'requestId': 'handoff'})
        result = await self.next_type(loser, 'share-result')
        self.assertTrue(result['granted'])

    async def test_departure_releases_share_and_existing_peers_remain(self):
        room = await self.room()
        a, ja = await self.join(room)
        b, jb = await self.join(room)
        c, jc = await self.join(room)
        await a.send_json({'type': 'share-request', 'requestId': 'a'})
        self.assertTrue((await self.next_type(a, 'share-result'))['granted'])
        await a.close()
        left = await self.next_type(b, 'peer-left')
        self.assertEqual(left['id'], ja['selfId'])
        await b.send_json({'type': 'share-request', 'requestId': 'b'})
        self.assertTrue((await self.next_type(b, 'share-result'))['granted'])
        self.assertEqual(len(self.app[SERVICE_KEY].rooms[room['roomId']].peers), 2)

    async def test_signal_routes_to_one_recipient_and_survives_new_join(self):
        room = await self.room()
        a, ja = await self.join(room)
        b, jb = await self.join(room)
        c, jc = await self.join(room)
        signal = {'description': {'type': 'offer', 'sdp': 'test-sdp'}}
        await a.send_json({'type': 'signal', 'to': jb['selfId'], 'from': jc['selfId'], 'epoch': -123, 'data': signal})
        received = await self.next_type(b, 'signal')
        self.assertEqual(received['from'], ja['selfId'])
        self.assertEqual(received['data'], signal)
        with self.assertRaises(asyncio.TimeoutError):
            await self.next_type(c, 'signal', .12)

    async def test_cross_room_signal_is_blocked(self):
        room1, room2 = await self.room(), await self.room()
        a, ja = await self.join(room1)
        b, jb = await self.join(room2)
        await a.send_json({'type': 'signal', 'to': jb['selfId'], 'data': {'description': {'type': 'offer', 'sdp': 'not-delivered'}}})
        with self.assertRaises(asyncio.TimeoutError):
            await self.next_type(b, 'signal', .12)

    async def test_state_cannot_claim_ungranted_screen(self):
        room = await self.room()
        a, ja = await self.join(room)
        b, jb = await self.join(room)
        await a.send_json({'type': 'state', 'mic': True, 'sharing': True, 'systemAudio': True})
        result = await self.next_type(b, 'peer-state')
        self.assertTrue(result['peer']['mic'])
        self.assertFalse(result['peer']['sharing'])
        self.assertFalse(result['peer']['systemAudio'])

    async def test_expiration_rejects_room_and_connection_slot_is_reusable(self):
        room = await self.room()
        self.app[SERVICE_KEY].rooms[room['roomId']].created -= self.settings.room_ttl + 1
        _, denied = await self.join(room)
        self.assertEqual(denied['code'], 'bad_room')
        self.settings.max_participants = 2
        room = await self.room()
        a, _ = await self.join(room)
        b, _ = await self.join(room)
        await b.close()
        await self.next_type(a, 'peer-left')
        c, joined = await self.join(room)
        self.assertEqual(joined['type'], 'joined')

    async def test_room_capacity_and_create_rate_limit(self):
        self.settings.max_rooms = 1
        await self.room()
        response = await self.client.post('/api/rooms', headers=self.headers, json={})
        self.assertEqual(response.status, 503)
        self.settings.max_rooms = 100
        for _ in range(10):
            await self.client.post('/api/rooms', headers=self.headers, json={})
        response = await self.client.post('/api/rooms', headers=self.headers, json={})
        self.assertEqual(response.status, 429)

    async def test_turn_credentials_are_authenticated_and_verifiable(self):
        self.settings.turn_urls = ('turn:relay.example:3478',)
        self.settings.turn_secret = 'test-secret-never-use-in-production'
        room = await self.room()
        _, joined = await self.join(room)
        server = joined['ice']['iceServers'][0]
        expected = base64.b64encode(hmac.new(self.settings.turn_secret.encode(), server['username'].encode(), hashlib.sha1).digest()).decode()
        self.assertEqual(server['credential'], expected)
        self.assertGreater(int(server['username'].split(':')[0]), time.time())
        config = await (await self.client.get('/api/config')).json()
        self.assertNotIn('test-secret', json.dumps(config))

    async def test_malformed_frames_do_not_crash_service(self):
        room = await self.room()
        a, _ = await self.join(room)
        await a.send_str('[1,2,3]')
        await a.receive(timeout=2)
        self.assertEqual((await self.client.get('/healthz')).status, 200)


class SettingsTests(unittest.TestCase):
    def test_rate_limiter_is_bounded(self):
        limiter = RateLimiter(maximum_keys=10)
        for index in range(100):
            self.assertTrue(limiter.allow(str(index), 1, 60))
        self.assertEqual(len(limiter.windows), 10)
        self.assertFalse(limiter.allow('99', 1, 60))


if __name__ == '__main__':
    unittest.main()
