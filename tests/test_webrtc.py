"""Real ICE/DTLS/SRTP media across three aiortc peers through our signaling server.

Synthetic audio/video are deliberately used; this is not an OS capture/browser test.
"""
import asyncio
import math
import time
import unittest
from unittest.mock import patch
from collections import Counter
from contextlib import suppress
from fractions import Fraction

import numpy as np
from aiohttp.test_utils import TestClient, TestServer
from aiortc import MediaStreamTrack, RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from av import AudioFrame, VideoFrame

from server import Settings, create_app


class Tone(MediaStreamTrack):
    kind = 'audio'

    def __init__(self, frequency):
        super().__init__()
        self.frequency = frequency
        self.samples = 0
        self.started = None

    async def recv(self):
        if self.started is None:
            self.started = time.monotonic()
        await asyncio.sleep(max(0, self.started + self.samples / 48000 - time.monotonic()))
        indices = np.arange(960) + self.samples
        values = (np.sin(indices * 2 * math.pi * self.frequency / 48000) * 10000).astype(np.int16)
        frame = AudioFrame.from_ndarray(values.reshape(1, -1), format='s16', layout='mono')
        frame.sample_rate = 48000
        frame.pts = self.samples
        frame.time_base = Fraction(1, 48000)
        self.samples += 960
        return frame


class Picture(MediaStreamTrack):
    kind = 'video'

    def __init__(self, color):
        super().__init__()
        self.color = color
        self.frames = 0
        self.started = None

    async def recv(self):
        if self.started is None:
            self.started = time.monotonic()
        await asyncio.sleep(max(0, self.started + self.frames / 15 - time.monotonic()))
        image = np.zeros((144, 256, 3), dtype=np.uint8)
        image[:, :, self.color] = 180
        image[:, (self.frames * 4) % 230: (self.frames * 4) % 230 + 20, :] = 240
        frame = VideoFrame.from_ndarray(image, format='rgb24')
        frame.pts = self.frames * 6000
        frame.time_base = Fraction(1, 90000)
        self.frames += 1
        return frame


class Participant:
    def __init__(self, client, origin, room, index):
        self.client, self.origin, self.room, self.index = client, origin, room, index
        self.id = None
        self.ws = None
        self.pcs = {}
        self.frames = Counter()
        self.energy = Counter()
        self.tasks = []
        self.errors = []
        self.sharing = False
        self.reader = None

    async def start(self):
        self.ws = await self.client.ws_connect('/ws', headers={'Origin': self.origin})
        await self.ws.send_json({'type': 'join', **self.room, 'name': f'participant-{self.index}'})
        joined = await self.ws.receive_json(timeout=2)
        assert joined['type'] == 'joined', joined
        self.id = joined['selfId']
        for peer in joined['peers']:
            self.make_pc(peer['id'])
        self.reader = asyncio.create_task(self.read())
        return self

    def make_pc(self, id):
        if id in self.pcs:
            return self.pcs[id]
        pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        self.pcs[id] = pc
        pc.addTransceiver(Tone(220 + self.index * 110), direction='sendrecv')
        pc.addTransceiver(Tone(1000) if self.sharing else 'audio', direction='sendrecv')
        pc.addTransceiver(Picture(self.index % 3) if self.sharing else 'video', direction='sendrecv')

        @pc.on('track')
        def track_received(track):
            slot = next(i for i, transceiver in enumerate(pc.getTransceivers()) if transceiver.receiver.track is track)

            async def consume():
                try:
                    while True:
                        frame = await track.recv()
                        self.frames[(id, slot)] += 1
                        if track.kind == 'audio':
                            self.energy[(id, slot)] += float(np.abs(frame.to_ndarray().astype(np.float64)).mean())
                except asyncio.CancelledError:
                    pass
                except Exception:
                    # Track ends when its peer is closed during teardown.
                    pass
            self.tasks.append(asyncio.create_task(consume()))
        return pc

    async def read(self):
        try:
            async for frame in self.ws:
                if frame.type.name != 'TEXT':
                    break
                import json
                message = json.loads(frame.data)
                if message['type'] == 'peer-joined':
                    pc = self.make_pc(message['peer']['id'])
                    await pc.setLocalDescription(await pc.createOffer())
                    await self.ws.send_json({'type': 'signal', 'to': message['peer']['id'],
                                             'data': {'description': {'type': pc.localDescription.type, 'sdp': pc.localDescription.sdp}}})
                elif message['type'] == 'signal':
                    pc = self.make_pc(message['from'])
                    description = message['data'].get('description')
                    if not description:
                        continue
                    await pc.setRemoteDescription(RTCSessionDescription(**description))
                    if description['type'] == 'offer':
                        await pc.setLocalDescription(await pc.createAnswer())
                        await self.ws.send_json({'type': 'signal', 'to': message['from'],
                                                 'data': {'description': {'type': pc.localDescription.type, 'sdp': pc.localDescription.sdp}}})
        except asyncio.CancelledError:
            pass
        except Exception as error:
            self.errors.append(repr(error))

    def share(self, enabled):
        self.sharing = enabled
        for pc in self.pcs.values():
            pc.getTransceivers()[1].sender.replaceTrack(Tone(1000) if enabled else None)
            pc.getTransceivers()[2].sender.replaceTrack(Picture(self.index % 3) if enabled else None)

    async def stop(self):
        if self.ws:
            await self.ws.close()
        if self.reader:
            self.reader.cancel()
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*(pc.close() for pc in self.pcs.values()))
        await asyncio.gather(*self.tasks, return_exceptions=True)
        if self.reader:
            with suppress(asyncio.CancelledError):
                await self.reader


class MediaIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_three_way_voice_screen_audio_and_share_handoff(self):
        # Keep this integration check entirely on loopback. Adapter enumeration
        # and outbound UDP can be unavailable in container/CI environments.
        loopback = patch('aioice.ice.get_host_addresses', return_value=['127.0.0.1'])
        loopback.start()
        self.addCleanup(loopback.stop)
        client = TestClient(TestServer(create_app(Settings(stun_urls=()))))
        await client.start_server()
        origin = str(client.make_url('/')).rstrip('/')
        room = await (await client.post('/api/rooms', headers={'Origin': origin}, json={})).json()
        participants = []

        async def wait_for(check, label, seconds=12):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                if check():
                    return
                errors = [error for participant in participants for error in participant.errors]
                self.assertFalse(errors, errors)
                await asyncio.sleep(.05)
            self.fail(f'Timed out waiting for {label}: {[dict(p.frames) for p in participants]}')

        try:
            for index in range(3):
                participants.append(await Participant(client, origin, room, index).start())
            a, b, c = participants
            await wait_for(lambda: all(len(p.pcs) == 2 and all(pc.connectionState == 'connected' for pc in p.pcs.values()) for p in participants), 'three connected peers')
            await wait_for(lambda: all(p.frames[(other.id, 0)] > 4 and p.energy[(other.id, 0)] > 100 for p in participants for other in participants if p is not other), 'all six voice directions')
            a.share(True)
            await wait_for(lambda: all(p.frames[(a.id, 1)] > 4 and p.frames[(a.id, 2)] > 4 for p in [b, c]), 'one screen and shared sound to two viewers')
            for pc in a.pcs.values():
                pc.getTransceivers()[0].sender.replaceTrack(None)
            await asyncio.sleep(.4)
            before_audio = b.frames[(a.id, 1)]
            before_video = b.frames[(a.id, 2)]
            await wait_for(lambda: b.frames[(a.id, 1)] > before_audio + 4 and b.frames[(a.id, 2)] > before_video + 4, 'shared sound/video continue after microphone mute')
            a.share(False)
            b.share(True)
            await wait_for(lambda: a.frames[(b.id, 2)] > 4 and c.frames[(b.id, 2)] > 4 and a.frames[(b.id, 1)] > 4, 'handoff without renegotiating voice')
            self.assertTrue(all(not p.errors for p in participants))
            print('\nReal WebRTC: 3 participants; 6 voice directions; screen + desktop audio to 2 viewers; microphone independence; share handoff: PASS')
        finally:
            await asyncio.gather(*(p.stop() for p in participants))
            await client.close()


if __name__ == '__main__':
    unittest.main()
