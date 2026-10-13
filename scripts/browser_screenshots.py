"""Real Chromium layout/interaction checks and screenshots.

The application and WebRTC sessions are real. Screen input is a labeled canvas
and test tone; microphone input is Chromium's fake device. No OS desktop chooser
or physical microphone is exercised. API/state/UI are not replaced.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]

SCREEN_SOURCE = r"""
(() => {
  const NativePeerConnection = window.RTCPeerConnection;
  window.__browserTestConnections = [];
  window.RTCPeerConnection = class extends NativePeerConnection {
    constructor(configuration) { super(configuration); window.__browserTestConnections.push(this); }
  };
  const media = navigator.mediaDevices;
  if (!media) return;
  media.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 720;
    const ctx = canvas.getContext('2d');
    let tick = 0;
    const round = (x, y, w, h, radius, color) => {
      ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); ctx.fill();
    };
    const draw = () => {
      ctx.fillStyle = '#e7ecdf'; ctx.fillRect(0, 0, 1280, 720);
      ctx.fillStyle = '#5f7366'; ctx.font = '20px sans-serif'; ctx.fillText('TONGPING / SHARED TEST CANVAS', 60, 57);
      ctx.fillStyle = '#1b3528'; ctx.font = '600 52px sans-serif'; ctx.fillText('一起把想法，放在一块画面上。', 60, 141);
      ctx.fillStyle = '#647567'; ctx.font = '25px sans-serif'; ctx.fillText('一人分享画面 · 每个人都能加入讨论', 62, 190);
      const cards = [
        ['#ccdcbe', '01 / 一起看', '网页、视频或游戏', '选择想分享的标签页'],
        ['#dbd1e3', '02 / 一起聊', '听见每个人的声音', '麦克风与视频音频独立'],
        ['#ead8bb', '03 / 随时分享', '你的屏幕，由你决定', '结束时点击停止共享'],
      ];
      cards.forEach(([color, kicker, title, text], index) => {
        const x = 60 + index * 397;
        round(x, 242, 369, 218, 20, color);
        ctx.fillStyle = '#516456'; ctx.font = '22px sans-serif'; ctx.fillText(kicker, x + 27, 290);
        ctx.fillStyle = '#23392b'; ctx.font = '500 29px sans-serif'; ctx.fillText(title, x + 27, 354);
        ctx.fillStyle = '#526355'; ctx.font = '20px sans-serif'; ctx.fillText(text, x + 27, 403);
      });
      round(60, 497, 1160, 124, 18, '#f7f8f2');
      ctx.fillStyle = '#55695d'; ctx.font = '22px sans-serif'; ctx.fillText('实时画面测试', 88, 539);
      ctx.strokeStyle = '#6c9569'; ctx.lineWidth = 3; ctx.beginPath();
      for (let x = 0; x < 680; x++) {
        const y = 562 + Math.sin(x / 28 + tick / 8) * Math.sin(x / 110) * 25;
        if (!x) ctx.moveTo(270 + x, y); else ctx.lineTo(270 + x, y);
      }
      ctx.stroke();
      round(1000, 537, 179, 37, 8, '#dae7d0');
      ctx.fillStyle = '#3d5b3b'; ctx.font = '19px sans-serif'; ctx.fillText('测试音轨已开启', 1015, 562);
      ctx.fillStyle = '#778575'; ctx.font = '18px sans-serif';
      ctx.fillText('合成音视频测试源 · 非用户桌面 · 用于界面与传输验证', 60, 672);
      tick++; window.__browserTestFrames = tick;
    };
    draw();
    const stream = canvas.captureStream(15);
    // requestAnimationFrame can stop when a different test page is foreground.
    // A timer plus explicit frame requests keeps this synthetic source live.
    setInterval(() => { draw(); stream.getVideoTracks()[0].requestFrame(); }, 1000 / 15);
    const sound = new AudioContext();
    await sound.resume();
    const oscillator = sound.createOscillator(), gain = sound.createGain(), destination = sound.createMediaStreamDestination();
    oscillator.frequency.value = 440; gain.gain.value = .04;
    oscillator.connect(gain).connect(destination); oscillator.start();
    for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
    return stream;
  };
})();
"""


def start_server():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    origin = f'http://localhost:{port}'
    env = {**os.environ, 'HOST': '127.0.0.1', 'PORT': str(port), 'PUBLIC_ORIGIN': origin,
           'STUN_URLS': '', 'TURN_URLS': '', 'ACCESS_KEY': '', 'MAX_PARTICIPANTS': '6'}
    process = subprocess.Popen([sys.executable, 'server.py'], cwd=ROOT, env=env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        if process.poll() is not None:
            raise RuntimeError('Screenshot application server exited early')
        try:
            with urllib.request.urlopen(origin + '/healthz', timeout=1) as response:
                if response.status == 200:
                    return process, origin
        except Exception:
            time.sleep(.1)
    process.terminate()
    raise RuntimeError('Screenshot application server did not start')


async def wait_for(page, predicate, timeout=30000):
    # Poll from Python using CDP evaluation rather than an in-page eval timer.
    # This preserves the application's strict CSP (no unsafe-eval bypass).
    deadline = asyncio.get_running_loop().time() + timeout / 1000
    while asyncio.get_running_loop().time() < deadline:
        if await page.evaluate("() => (" + predicate + ")"):
            return
        await asyncio.sleep(.1)
    raise TimeoutError('Browser condition not reached: ' + predicate)


async def assert_layout(page, label, checks):
    result = await page.evaluate("""() => {
      const visible = [...document.querySelectorAll('button, input, select, .panel, .viewer-panel')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      });
      const clipped = visible.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left < -1 || r.right > innerWidth + 1;
      }).map((el) => el.id || el.className);
      const stage = document.getElementById('stage');
      const empty = document.getElementById('stageEmpty');
      const stageRect = stage.getBoundingClientRect();
      const controls = [...empty.querySelectorAll('button')].filter(el => !el.hidden);
      const hiddenEmptyControls = empty.hidden ? [] : controls.filter(el => {
        const r = el.getBoundingClientRect();
        return r.top < stageRect.top - 1 || r.bottom > stageRect.bottom + 1;
      }).map(el => el.id);
      return {overflow: document.documentElement.scrollWidth > innerWidth + 1, clipped, hiddenEmptyControls};
    }""")
    assert not result['overflow'] and not result['clipped'] and not result['hiddenEmptyControls'], f'{label}: {result}'
    checks.append(label)


async def run(output, origin):
    errors, checks = [], []
    async with async_playwright() as driver:
        browser = await driver.chromium.launch(headless=True, args=[
            '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
        ])
        contexts = []
        try:
            for _ in range(3):
                context = await browser.new_context(viewport={'width': 1440, 'height': 980},
                    device_scale_factor=1, locale='zh-CN', reduced_motion='reduce',
                    permissions=['microphone', 'clipboard-read', 'clipboard-write'])
                await context.add_init_script(SCREEN_SOURCE)
                contexts.append(context)
            pages = [await context.new_page() for context in contexts]
            for page in pages:
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
            owner, friend, third = pages
            await owner.goto(origin, wait_until='networkidle')
            await owner.evaluate('document.fonts.ready')
            await assert_layout(owner, 'desktop lobby has no horizontal overflow or clipped controls', checks)
            await owner.screenshot(path=str(output / 'lobby-desktop.png'), full_page=True)
            await owner.locator('#displayName').fill('阿禾')
            await owner.locator('#createButton').click()
            await owner.locator('#room').wait_for(state='visible')
            await wait_for(owner, "document.getElementById('micButton').getAttribute('aria-pressed') === 'true'")
            invitation = owner.url
            for page, name in [(friend, '小林'), (third, '夏夏')]:
                await page.goto(invitation, wait_until='networkidle')
                assert await page.locator('#joinFields').is_visible()
                await page.locator('#displayName').fill(name)
                await page.locator('#displayName').press('Enter')
                await page.locator('#room').wait_for(state='visible')
            for page in pages:
                await wait_for(page, "document.getElementById('memberCount').textContent === '3 / 6'")
                await wait_for(page, "document.getElementById('networkStatus').textContent.includes('已连接 2 / 2')", timeout=30000)
            checks.append('three real Chromium pages join one room and establish all peer connections')
            for page in pages:
                await wait_for(page, """(async () => {
                  const pcs = window.__browserTestConnections || [];
                  if (pcs.length !== 2) return false;
                  for (const pc of pcs) {
                    const reports = [...(await pc.getStats()).values()];
                    if (!reports.some(r => r.type === 'inbound-rtp' && r.kind === 'audio' && r.bytesReceived > 0)) return false;
                    if (!reports.some(r => r.type === 'outbound-rtp' && r.kind === 'audio' && r.bytesSent > 0)) return false;
                  }
                  return document.querySelectorAll('audio[data-kind="voice"]').length === 2;
                })()""")
            checks.append('all six microphone directions send and receive RTP and attach playback elements')
            await assert_layout(owner, 'desktop empty stage invitation and sharing actions remain visible', checks)
            await owner.locator('#shareButton').click()
            for page in pages:
                await wait_for(page, "(() => { const v = document.getElementById('screenVideo'); return !v.hidden && v.videoWidth > 0 && v.readyState >= 2; })()", timeout=30000)
            assert await friend.locator('#shareButton').is_disabled()
            assert await third.locator('#shareButton').is_disabled()
            await wait_for(owner, "Number(document.getElementById('uploadValue').textContent) > 0", timeout=30000)
            await wait_for(friend, "Number(document.getElementById('downloadValue').textContent) > 0", timeout=30000)
            checks.append('synthetic screen and desktop-audio stream reach both viewers over real WebRTC')
            await wait_for(owner, "document.getElementById('toast').hidden")
            await wait_for(friend, "document.getElementById('toast').hidden")
            await wait_for(owner, "[...document.querySelectorAll('.voice-meter')].some(el => Number(el.getAttribute('aria-valuenow')) > 0)")
            checks.append('real AudioContext analysis produces measured voice-meter values')
            await assert_layout(owner, 'desktop shared-screen controls and sidebars stay within viewport', checks)
            await owner.screenshot(path=str(output / 'room-desktop.png'), full_page=True)
            await friend.screenshot(path=str(output / 'room-viewer.png'), full_page=True)
            await friend.locator('#voiceVolume').evaluate("el => { el.value = '37'; el.dispatchEvent(new Event('input', {bubbles:true})); }")
            await friend.locator('#volume').evaluate("el => { el.value = '64'; el.dispatchEvent(new Event('input', {bubbles:true})); }")
            assert await friend.evaluate("[...document.querySelectorAll('audio[data-kind=voice]')].every(a => Math.abs(a.volume - .37) < .001)")
            await friend.locator('#listenButton').click()
            assert await friend.evaluate("[...document.querySelectorAll('#remoteAudio audio')].every(a => a.muted)")
            assert await friend.locator('#micButton').get_attribute('aria-pressed') == 'true'
            await friend.locator('#listenButton').click()
            checks.append('browser playback volumes and listening mute remain independent of microphone sending')
            await owner.locator('#focusButton').click()
            assert not await owner.locator('.people-sidebar').is_visible()
            await owner.screenshot(path=str(output / 'room-focus.png'), full_page=True)
            await owner.keyboard.press('Escape')
            assert await owner.locator('.people-sidebar').is_visible()
            checks.append('focused viewing enters and Escape restores the sidebars')
            for width in [320, 390, 640, 800, 1024, 1280, 1440]:
                await friend.set_viewport_size({'width': width, 'height': 844})
                await assert_layout(friend, f'room responsive layout at {width}px', checks)
            await friend.set_viewport_size({'width': 390, 'height': 844})
            await friend.screenshot(path=str(output / 'room-mobile.png'), full_page=True)
            await owner.locator('#micButton').click()
            await wait_for(owner, "document.getElementById('micButton').getAttribute('aria-pressed') === 'false'")
            assert await owner.locator('#systemAudioButton').get_attribute('aria-pressed') == 'true'
            await wait_for(friend, "!document.getElementById('screenVideo').hidden && document.getElementById('screenVideo').readyState >= 2")
            checks.append('microphone mute leaves shared screen and desktop-audio enabled')
            await owner.locator('#shareButton').click()
            await wait_for(friend, "!document.getElementById('shareButton').disabled")
            await friend.locator('#shareButton').click()
            await wait_for(owner, "document.getElementById('stageStatus').textContent.includes('小林 正在共享') && !document.getElementById('screenVideo').hidden && document.getElementById('screenVideo').videoWidth > 0")
            checks.append('screen sharing handoff enables the next participant and delivers new video')
            await friend.locator('#shareButton').click()
            await owner.locator('#leaveButton').click()
            for width in [320, 390, 800, 1280, 1440]:
                await owner.set_viewport_size({'width': width, 'height': 844})
                await assert_layout(owner, f'lobby responsive layout at {width}px', checks)
            await owner.set_viewport_size({'width': 390, 'height': 844})
            await owner.screenshot(path=str(output / 'lobby-mobile.png'), full_page=True)
            manifest = await owner.evaluate("fetch('/app.webmanifest').then(r => r.json())")
            assert manifest['display'] == 'standalone'
            await wait_for(owner, "navigator.serviceWorker.controller !== null", timeout=15000)
            checks.append('browser loads installable manifest and activates the real service worker')
            assert not errors, f'Browser errors: {errors}'
            return {'browser': browser.version, 'checks': checks, 'browser_errors': errors,
                'input': 'Chromium fake microphone; labeled canvas plus test tone as display source',
                'scope': 'Real Chromium render, three-page WebRTC, responsive layout and controls; no OS capture chooser, Windows installer, physical device or cross-network TURN test.'}
        except Exception:
            diagnostics = []
            for index, page in enumerate(pages if 'pages' in locals() else []):
                if not page.is_closed():
                    diagnostics.append(await page.evaluate("""async () => {
                      const video = document.getElementById('screenVideo');
                      const connections = [];
                      for (const pc of window.__browserTestConnections || []) {
                        const reports = [...(await pc.getStats()).values()].filter(r => ['outbound-rtp','inbound-rtp'].includes(r.type));
                        connections.push({state:pc.connectionState, ice:pc.iceConnectionState,
                          slots:pc.getTransceivers().map(t => ({mid:t.mid, direction:t.currentDirection, send:t.sender.track?.kind, sendState:t.sender.track?.readyState, receive:t.receiver.track?.kind, receiveMuted:t.receiver.track?.muted})),
                          media:reports.map(r => ({kind:r.kind, bytesSent:r.bytesSent, bytesReceived:r.bytesReceived, framesEncoded:r.framesEncoded, framesDecoded:r.framesDecoded}))});
                      }
                      return {visibility:document.visibilityState, fixtureFrames:window.__browserTestFrames,
                        video:{hidden:video.hidden,width:video.videoWidth,height:video.videoHeight,readyState:video.readyState,paused:video.paused, tracks:video.srcObject?.getTracks().map(t=>({kind:t.kind,muted:t.muted,state:t.readyState}))}, connections};
                    }"""))
                    await page.screenshot(path=str(output / f'failure-{index}.png'), full_page=True)
            (output / 'diagnostics.json').write_text(json.dumps({'checks':checks,'errors':errors,'pages':diagnostics}, indent=2) + '\n')
            print(json.dumps({'browser_diagnostics':diagnostics, 'errors':errors}))
            raise
        finally:
            for context in contexts:
                await context.close()
            await browser.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', default='test-results')
    args = parser.parse_args()
    output = Path(args.output_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    process, origin = start_server()
    try:
        summary = asyncio.run(run(output, origin))
        (output / 'summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False) + '\n')
        print(json.dumps(summary, ensure_ascii=False))
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


if __name__ == '__main__':
    main()
