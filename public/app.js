import { PeerSession, PRESETS } from './rtc.js';

const $ = (id) => document.getElementById(id);
const state = {
  config: null, credentials: null, ws: null, selfId: null, epoch: 0,
  peers: new Map(), sessions: new Map(), peerStats: new Map(), ice: null, joined: false,
  micStream: null, screenStream: null, remoteVideos: new Map(),
  systemAudioMuted: false, busyMic: false, busyShare: false, stoppingShare: false,
  leaving: false, retry: 0, retryTimer: null, terminal: false,
  quality: 'economy', mediaRevision: 0, pending: new Map(),
};
let toastTimer;

function toast(message, error = false) {
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 7000 : 4000);
}

function mediaError(error) {
  if (error.name === 'NotAllowedError') return '未获得授权。你可以继续留在房间，再点击按钮开启。';
  if (error.name === 'NotFoundError') return '没有找到麦克风或可共享的画面。请检查设备。';
  if (error.name === 'NotReadableError') return '设备暂时无法使用，请检查系统权限或其他软件是否正在占用。';
  if (error.name === 'InvalidStateError') return '请回到这个页面，再点击共享按钮选择画面。';
  return error.message || '操作未完成，请重试。';
}

function safeStorageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function safeStorageSet(key, value) { try { localStorage.setItem(key, value); } catch {} }

function parseInvite(value) {
  const url = new URL(value, location.origin);
  if (url.origin !== location.origin) throw new Error('邀请来自另一个服务器，请直接在浏览器中打开原链接。');
  const match = /^\/r\/([a-z0-9]{12})$/.exec(url.pathname);
  const key = new URLSearchParams(url.hash.slice(1)).get('key');
  if (!match || !key || !/^[a-zA-Z0-9_-]{43}$/.test(key)) throw new Error('请粘贴完整邀请链接，包含 #key= 后面的房间钥匙。');
  return { roomId: match[1], key };
}

function inviteLink() {
  const { roomId, key } = state.credentials;
  return `${location.origin}/r/${roomId}#key=${encodeURIComponent(key)}`;
}

function send(payload) {
  if (state.joined && state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function requestShare() {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error('共享请求超时，请检查连接后重试。'));
    }, 7000);
    state.pending.set(id, { resolve, reject, timer });
    if (!send({ type: 'share-request', requestId: id })) {
      clearTimeout(timer); state.pending.delete(id);
      reject(new Error('房间正在重新连接，请稍后共享。'));
    }
  });
}

function rejectPending() {
  for (const pending of state.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error('连接中断，请重新尝试共享。'));
  }
  state.pending.clear();
}

function localState() {
  return {
    type: 'state', mic: Boolean(state.micStream?.getAudioTracks().some((t) => t.readyState === 'live' && t.enabled)),
    sharing: Boolean(state.screenStream),
    systemAudio: Boolean(state.screenStream?.getAudioTracks().some((t) => t.readyState === 'live' && t.enabled)),
  };
}

function publishState() { send(localState()); render(); }

async function playAudio() {
  let blocked = false;
  for (const element of $('remoteAudio').querySelectorAll('audio')) {
    if (element.srcObject) {
      try { await element.play(); } catch (error) { if (error.name === 'NotAllowedError') blocked = true; }
    }
  }
  $('audioPrompt').hidden = !blocked;
}

function render() {
  const local = localState();
  const peers = [...state.peers.values()];
  const friend = peers.find((peer) => peer.sharing);
  $('memberCount').textContent = `${peers.length + 1} / ${state.config?.maxParticipants || 6}`;
  $('selfName').textContent = state.credentials?.name || '你';
  $('selfAvatar').textContent = (state.credentials?.name || '你').slice(0, 1);
  $('selfState').textContent = `${local.mic ? '语音已开启' : '麦克风已关闭'}${local.sharing ? ' · 正在共享' : ''}`;
  const members = peers.map((peer) => {
    const item = document.createElement('div'); item.className = 'member';
    const avatar = document.createElement('span'); avatar.className = 'avatar friend-avatar'; avatar.textContent = peer.name.slice(0, 1);
    const text = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = peer.name;
    const status = document.createElement('small'); status.textContent = `${peer.mic ? '语音已开启' : '麦克风已关闭'}${peer.sharing ? ' · 正在共享' : ''}`;
    const dot = document.createElement('span'); dot.className = `dot${peer.mic ? '' : ' inactive'}`;
    text.append(name, status); item.append(avatar, text, dot);
    return item;
  });
  if (!members.length) { const empty = document.createElement('p'); empty.className = 'small-note'; empty.textContent = '等待朋友们加入，分享邀请链接就好。'; members.push(empty); }
  $('membersList').replaceChildren(...members);
  $('remoteAudio').querySelectorAll('audio[data-kind="desktop-audio"]').forEach((element) => {
    element.muted = !state.peers.get(element.dataset.peer)?.sharing;
  });
  $('micLabel').textContent = state.busyMic ? '正在授权…' : local.mic ? '关闭语音' : '开启语音';
  $('micButton').setAttribute('aria-pressed', String(local.mic));
  $('micButton').classList.toggle('active', local.mic);
  $('micButton').disabled = state.busyMic || !state.credentials;
  $('shareButton').textContent = state.busyShare ? '正在选择画面…' : local.sharing ? '■ 停止共享' : '▣ 共享屏幕';
  $('shareButton').classList.toggle('sharing', local.sharing);
  $('shareButton').disabled = state.busyShare || (!local.sharing && (!state.joined || Boolean(friend?.sharing)));
  const hasAudio = Boolean(state.screenStream?.getAudioTracks().some((t) => t.readyState === 'live'));
  $('systemAudioButton').disabled = !hasAudio;
  $('systemAudioButton').setAttribute('aria-pressed', String(local.systemAudio));
  $('systemAudioButton').classList.toggle('active', local.systemAudio);
  $('systemAudioLabel').textContent = hasAudio ? local.systemAudio ? '声音已共享' : '共享声已静音' : '未捕获电脑声音';

  let stream = state.screenStream;
  let owner = stream ? '你的画面 · 本地预览' : '';
  if (!stream && friend && state.remoteVideos.has(friend.id)) {
    stream = new MediaStream([state.remoteVideos.get(friend.id)]);
    owner = `${friend.name} 的画面`;
  }
  const video = $('screenVideo');
  const track = stream?.getVideoTracks()[0];
  if (video.srcObject?.getVideoTracks()[0] !== track) video.srcObject = stream || null;
  video.hidden = !stream;
  $('stageEmpty').hidden = Boolean(stream);
  $('stageOverlay').hidden = !stream;
  $('screenOwner').textContent = owner;
  $('stageTitle').textContent = friend ? '画面正在连接…' : peers.length ? '大家已经在这里了。' : '你的屏幕，准备好了。';
  $('stageHint').textContent = friend ? '保持页面打开，画面会在连接完成后显示。' : peers.length ? '一位朋友共享画面，所有人都能一起聊。' : '邀请朋友们加入，然后点击下方「共享屏幕」。';
  $('emptyInviteButton').hidden = Boolean(peers.length);
  const preset = PRESETS[state.quality];
  $('qualityHint').textContent = `每位观看者画面码率上限 ${(preset.bitrate / 1000000).toFixed(1)} Mbps。${peers.length ? `向 ${peers.length} 位传送时，画面总上传上限约 ${(preset.bitrate * peers.length / 1000000).toFixed(1)} Mbps。` : '默认适合网页和代码。'}`;
  if (state.screenStream) {
    const settings = track?.getSettings() || {};
    $('screenSpec').textContent = settings.width ? `${settings.width} × ${settings.height}` : preset.label;
  }
}

function resetPeer(id) {
  state.sessions.get(id)?.close();
  state.sessions.delete(id);
  state.remoteVideos.delete(id);
  state.peerStats.delete(id);
  $('remoteAudio').querySelectorAll(`audio[data-peer="${id}"]`).forEach((element) => {
    element.srcObject = null; element.remove();
  });
}

function resetAllPeers() {
  for (const id of [...state.sessions.keys()]) resetPeer(id);
  $('remoteAudio').replaceChildren();
  $('screenSpec').textContent = '';
  $('audioPrompt').hidden = true;
  $('detailPath').textContent = '等待连接';
  $('detailRtt').textContent = $('detailTraffic').textContent = $('detailVideo').textContent = '—';
}

async function syncTracks(session = null) {
  const sessions = session ? [session] : [...state.sessions.values()];
  await Promise.all(sessions.map(async (peerSession) => {
    await peerSession.setTrack(0, state.micStream?.getAudioTracks()[0]);
    await peerSession.setTrack(1, state.screenStream?.getAudioTracks()[0]);
    await peerSession.setTrack(2, state.screenStream?.getVideoTracks()[0]);
    await peerSession.applyQuality(PRESETS[state.quality]);
  }));
}

function renderStats() {
  const all = [...state.peerStats.values()];
  const direct = all.filter((stats) => stats.path === 'direct').length;
  const relay = all.filter((stats) => stats.path === 'relay').length;
  const path = all.length ? `直连 ${direct} · 中继 ${relay}` : '正在检测';
  const rtts = all.map((stats) => stats.rtt).filter((rtt) => rtt != null);
  const rtt = rtts.length ? Math.max(...rtts) : null;
  const sent = all.reduce((sum, stats) => sum + stats.sent, 0);
  const received = all.reduce((sum, stats) => sum + stats.received, 0);
  $('detailPath').textContent = path;
  $('detailRtt').textContent = rtt == null ? '—' : `${rtt} ms`;
  $('detailTraffic').textContent = `${sent.toFixed(2)} / ${received.toFixed(2)} Mbps`;
  const owner = [...state.peers.values()].find((peer) => peer.sharing);
  const stats = owner ? state.peerStats.get(owner.id) : all.find((sample) => sample.width);
  const dimensions = stats?.width ? `${stats.width} × ${stats.height}${stats.fps != null ? ` · ${Math.round(stats.fps)} 帧` : ''}` : '暂无画面';
  $('detailVideo').textContent = dimensions;
  $('trafficStatus').textContent = `${path} · ${rtt == null ? '正在测量' : `最慢 ${rtt} ms`}`;
  if (owner) $('screenSpec').textContent = stats?.width ? dimensions : '';
  const sessions = [...state.sessions.values()];
  const connected = sessions.filter((session) => session.pc.connectionState === 'connected').length;
  const failed = sessions.some((session) => ['failed', 'disconnected'].includes(session.pc.connectionState));
  if (state.joined) {
    $('networkStatus').textContent = sessions.length ? `已连接 ${connected} / ${sessions.length} 位${failed ? ' · 部分连接不稳定' : ''}` : '等待朋友们加入';
    $('networkStatus').classList.toggle('warning', failed);
  }
}

async function connectPeer(id, initiate) {
  resetPeer(id);
  let session;
  session = new PeerSession({
    ice: state.ice, polite: !initiate,
    send: (data) => {
      if (state.sessions.get(id) === session) send({ type: 'signal', to: id, data });
    },
    onTrack: (kind, track) => {
      if (state.sessions.get(id) !== session) return;
      if (kind === 'screen') {
        state.remoteVideos.set(id, track);
        track.onunmute = () => render();
        render();
      } else {
        let element = $('remoteAudio').querySelector(`audio[data-peer="${id}"][data-kind="${kind}"]`);
        if (!element) {
          element = document.createElement('audio'); element.autoplay = true;
          element.dataset.peer = id; element.dataset.kind = kind;
          $('remoteAudio').append(element);
        }
        element.srcObject = new MediaStream([track]);
        element.volume = kind === 'voice' ? 1 : Number($('volume').value) / 100;
        element.muted = kind === 'desktop-audio' && !state.peers.get(id)?.sharing;
        void playAudio();
      }
    },
    onState: (status) => {
      if (state.sessions.get(id) === session) renderStats();
    },
    onStats: (stats) => {
      if (state.sessions.get(id) !== session) return;
      state.peerStats.set(id, stats); renderStats();
    },
    onError: (error) => {
      if (state.sessions.get(id) === session && !state.leaving) toast(`${state.peers.get(id)?.name || '一位朋友'} 的连接遇到问题：${mediaError(error)}`, true);
    },
  });
  state.sessions.set(id, session);
  try {
    await syncTracks(session);
    if (state.sessions.get(id) !== session) return;
    if (initiate) await session.offer();
  } catch (error) { if (state.sessions.get(id) === session) toast(mediaError(error), true); }
}

async function handleMessage(data) {
  if (data.type === 'joined') {
    state.joined = true; state.retry = 0; state.selfId = data.selfId;
    state.epoch = data.epoch; state.ice = data.ice;
    resetAllPeers();
    state.peers = new Map(data.peers.map((peer) => [peer.id, peer]));
    // Install all pair handlers before awaiting a sharing-grant round trip.
    // Offers from existing participants can arrive during that round trip.
    const connections = Promise.all(data.peers.map((peer) => connectPeer(peer.id, false)));
    $('reconnectPrompt').hidden = true;
    $('roomTag').textContent = `房间 ${state.credentials.roomId.slice(0, 6).toUpperCase()}`;
    $('networkStatus').textContent = data.peers.length ? '正在连接大家的语音与画面' : '等待朋友们加入';
    if (state.screenStream) {
      // Reconnection gets a fresh server-controlled sharing grant.
      try { if (!await requestShare()) await stopShare(); }
      catch { await stopShare(); }
    }
    publishState();
    await connections;
  } else if (data.type === 'peer-joined') {
    state.peers.set(data.peer.id, data.peer); state.epoch = data.epoch;
    publishState();
    toast(`${data.peer.name} 加入了房间`);
    await connectPeer(data.peer.id, true);
  } else if (data.type === 'peer-left') {
    state.epoch = data.epoch; state.peers.delete(data.id);
    resetPeer(data.id);
    render(); renderStats();
  } else if (data.type === 'peer-state' && state.peers.has(data.peer.id)) {
    state.peers.set(data.peer.id, data.peer);
    render();
  } else if (data.type === 'signal' && state.peers.has(data.from)) {
    await state.sessions.get(data.from)?.receive(data.data);
  } else if (data.type === 'share-result') {
    const pending = state.pending.get(data.requestId);
    if (pending) { clearTimeout(pending.timer); state.pending.delete(data.requestId); pending.resolve(data.granted); }
  } else if (data.type === 'ice-config') {
    state.ice = data.ice;
    for (const session of state.sessions.values()) { session.pc.setConfiguration(data.ice); session.restart(); }
  } else if (data.type === 'error') {
    state.terminal = true;
    toast(data.message || '房间连接失败', true);
    leaveRoom(false);
  }
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    state.ws = socket;
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('服务器连接超时')); socket.close(); } }, 12000);
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'join', ...state.credentials }));
    };
    socket.onmessage = ({ data }) => {
      if (state.ws !== socket) return;
      let payload;
      try { payload = JSON.parse(data); } catch { return; }
      if (payload.type === 'joined' && !settled) { settled = true; clearTimeout(timer); resolve(); }
      if (payload.type === 'error' && !settled) { settled = true; clearTimeout(timer); reject(new Error(payload.message)); }
      // Share-result must be handled immediately: joined may await a share grant.
      void handleMessage(payload).catch((error) => toast(mediaError(error), true));
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(new Error('未能连接房间，请检查服务器和邀请链接')); }
      if (state.ws !== socket) return;
      state.joined = false;
      rejectPending();
      render();
      if (state.credentials && !state.leaving && !state.terminal) scheduleReconnect();
    };
  });
}

function scheduleReconnect() {
  clearTimeout(state.retryTimer);
  $('networkStatus').textContent = '房间连接中断，正在恢复…';
  if (state.retry >= 8) {
    $('reconnectPrompt').hidden = false;
    return;
  }
  const delay = Math.min(800 * 2 ** state.retry++, 8000);
  state.retryTimer = setTimeout(() => { void connectSocket().catch(() => {}); }, delay);
}

async function enterRoom(credentials) {
  if (!window.isSecureContext || !navigator.mediaDevices || !window.RTCPeerConnection) throw new Error('需要 HTTPS 或本机 localhost，并使用支持 WebRTC 的浏览器。');
  leaveRoom(false);
  state.leaving = false; state.terminal = false; state.credentials = credentials;
  await connectSocket();
  if (!state.credentials) return;
  history.replaceState(null, '', inviteLink());
  $('lobby').hidden = true; $('room').hidden = false;
  render();
  safeStorageSet('tongping-name', credentials.name);
  if ($('joinMic').checked) await enableMic();
  void playAudio();
}

async function enableMic() {
  if (state.busyMic || state.micStream) return;
  const revision = state.mediaRevision;
  state.busyMic = true; render();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false,
    });
    if (revision !== state.mediaRevision || !state.credentials) { stream.getTracks().forEach((t) => t.stop()); return; }
    state.micStream = stream;
    stream.getAudioTracks()[0].onended = () => { void disableMic(); toast('麦克风已断开，可以重新开启。', true); };
    await Promise.all([...state.sessions.values()].map((session) => session.setTrack(0, stream.getAudioTracks()[0])));
    publishState();
  } catch (error) { toast(mediaError(error), true); }
  finally { state.busyMic = false; render(); }
}

async function disableMic() {
  const stream = state.micStream;
  state.micStream = null;
  stream?.getTracks().forEach((t) => t.stop());
  await Promise.all([...state.sessions.values()].map((session) => session.setTrack(0, null)));
  publishState();
}

async function startShare() {
  if (state.busyShare || state.screenStream) return;
  if (!navigator.mediaDevices?.getDisplayMedia) { toast('当前设备可以观看，但不支持从浏览器共享屏幕。请用电脑 Chrome / Edge。', true); return; }
  const revision = state.mediaRevision;
  const preset = PRESETS[state.quality];
  state.busyShare = true; render();
  let captured;
  let granted = false;
  try {
    // Must be called directly from the user's click, before any network await.
    captured = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: preset.width }, height: { ideal: preset.height }, frameRate: { ideal: preset.fps } },
      audio: true, systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
    });
    if (revision !== state.mediaRevision || !state.credentials) { captured.getTracks().forEach((t) => t.stop()); return; }
    granted = await requestShare();
    if (!granted) throw new Error('对方正在共享画面。请等 TA 停止后再开始。');
    if (revision !== state.mediaRevision) { captured.getTracks().forEach((t) => t.stop()); return; }
    if (captured.getVideoTracks()[0]?.readyState !== 'live') throw new Error('共享已经停止，请重新选择画面。');
    state.screenStream = captured; state.systemAudioMuted = false;
    captured.getVideoTracks()[0].onended = () => { void stopShare(); };
    for (const audio of captured.getAudioTracks()) audio.onended = () => publishState();
    await applyQuality();
    await syncTracks();
    publishState();
    if (!captured.getAudioTracks().length) toast('画面已共享，但没有捕获电脑声音。分享标签页时请勾选音频。');
    else if (captured.getVideoTracks()[0].getSettings().displaySurface === 'monitor') toast('共享桌面声音可能带上房间语音。出现回声时，请改为只共享视频标签页。');
  } catch (error) {
    captured?.getTracks().forEach((t) => t.stop());
    if (state.screenStream === captured) state.screenStream = null;
    if (revision === state.mediaRevision && captured) {
      // An acknowledgement can be lost after the server has granted sharing.
      // Releasing our own grant is safe even if the peer won the simultaneous request.
      send({ type: 'share-stop' }); await syncTracks().catch(() => {});
    }
    toast(mediaError(error), true);
  } finally { state.busyShare = false; render(); }
}

async function stopShare() {
  if (state.stoppingShare) return;
  state.stoppingShare = true;
  const stream = state.screenStream;
  state.screenStream = null; state.systemAudioMuted = false;
  stream?.getTracks().forEach((t) => t.stop());
  send({ type: 'share-stop' });
  try { await syncTracks(); } catch (error) { toast(mediaError(error), true); }
  finally { state.stoppingShare = false; publishState(); }
}

async function applyQuality() {
  const preset = PRESETS[state.quality];
  const track = state.screenStream?.getVideoTracks()[0];
  if (track) {
    track.contentHint = state.quality === 'smooth' ? 'motion' : 'detail';
    await track.applyConstraints({ width: { max: preset.width }, height: { max: preset.height }, frameRate: { max: preset.fps } });
  }
  await Promise.all([...state.sessions.values()].map((session) => session.applyQuality(preset)));
  render();
}

function leaveRoom(updateUrl = true) {
  state.leaving = true; state.mediaRevision++;
  clearTimeout(state.retryTimer);
  rejectPending();
  const socket = state.ws;
  state.ws = null; state.joined = false;
  socket?.close();
  state.micStream?.getTracks().forEach((t) => t.stop());
  state.screenStream?.getTracks().forEach((t) => t.stop());
  state.micStream = state.screenStream = null;
  state.peers.clear(); state.credentials = null; state.retry = 0;
  resetAllPeers();
  $('room').hidden = true; $('lobby').hidden = false;
  $('reconnectPrompt').hidden = true;
  $('inviteDialog').close();
  if (updateUrl) history.replaceState(null, '', '/');
  render();
}

async function copyInvite() {
  if (!state.credentials) return;
  const link = inviteLink();
  try { await navigator.clipboard.writeText(link); toast('邀请链接已复制，发给朋友们就好。'); }
  catch {
    $('inviteLink').value = link;
    $('inviteDialog').showModal();
    $('inviteLink').select();
  }
}

function lobbyBusy(busy) { $('createButton').disabled = $('joinButton').disabled = busy; }

$('roomForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  lobbyBusy(true);
  try {
    const response = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessKey: $('accessKey').value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '创建房间失败');
    await enterRoom({ roomId: data.roomId, key: data.key, name: $('displayName').value.trim() || '访客' });
  } catch (error) { toast(mediaError(error), true); }
  finally { lobbyBusy(false); }
});
$('joinButton').addEventListener('click', async () => {
  if (!$('displayName').reportValidity()) return;
  lobbyBusy(true);
  try { await enterRoom({ ...parseInvite($('inviteInput').value.trim()), name: $('displayName').value.trim() || '访客' }); }
  catch (error) { toast(mediaError(error), true); }
  finally { lobbyBusy(false); }
});
$('micButton').addEventListener('click', () => { void (state.micStream ? disableMic() : enableMic()).catch((error) => toast(mediaError(error), true)); });
$('shareButton').addEventListener('click', () => { void (state.screenStream ? stopShare() : startShare()); });
$('systemAudioButton').addEventListener('click', () => {
  state.systemAudioMuted = !state.systemAudioMuted;
  state.screenStream?.getAudioTracks().forEach((t) => { t.enabled = !state.systemAudioMuted; });
  publishState();
});
$('volume').addEventListener('input', () => {
  $('remoteAudio').querySelectorAll('audio[data-kind="desktop-audio"]').forEach((element) => { element.volume = Number($('volume').value) / 100; });
  $('volumeValue').textContent = `${$('volume').value}%`;
});
$('quality').addEventListener('change', async () => {
  const previous = state.quality;
  state.quality = $('quality').value;
  $('quality').disabled = true;
  try { await applyQuality(); }
  catch (error) { state.quality = previous; $('quality').value = previous; await applyQuality().catch(() => {}); toast(`画质调整未完成：${mediaError(error)}`, true); }
  finally { $('quality').disabled = false; }
});
$('fullscreenButton').addEventListener('click', () => {
  const action = document.fullscreenElement ? document.exitFullscreen() : $('stage').requestFullscreen?.();
  action?.catch(() => toast('当前浏览器没有允许全屏。'));
});
$('leaveButton').addEventListener('click', () => leaveRoom());
$('inviteButton').addEventListener('click', () => { void copyInvite(); });
$('emptyInviteButton').addEventListener('click', () => { void copyInvite(); });
$('copyDialogLink').addEventListener('click', () => { void copyInvite(); });
$('closeInvite').addEventListener('click', () => $('inviteDialog').close());
$('resumeAudio').addEventListener('click', () => { void playAudio(); });
$('reconnectButton').addEventListener('click', () => { state.retry = 0; scheduleReconnect(); });
$('retryConnection').addEventListener('click', () => {
  if (!state.joined) { state.retry = 0; scheduleReconnect(); }
  else if (state.peers.size) { send({ type: 'ice-refresh' }); toast('正在重试语音与画面连接'); }
  else toast('朋友们加入后即可建立连接。');
});
window.addEventListener('beforeunload', () => leaveRoom(false));
window.addEventListener('online', () => { if (state.credentials && !state.joined) { state.retry = 0; scheduleReconnect(); } });

$('displayName').value = safeStorageGet('tongping-name') || '';
if (location.pathname.startsWith('/r/')) {
  $('inviteInput').value = location.href;
  $('joinTitle').textContent = '朋友在等你';
  $('joinSubtitle').textContent = '填写昵称，点击「加入房间」即可。';
}
if (!window.isSecureContext || !navigator.mediaDevices) {
  $('compatibility').textContent = '浏览器需要 HTTPS 才能开启语音和共享。仅本机 localhost 可以使用 HTTP。';
  $('compatibility').hidden = false;
} else if (!navigator.mediaDevices.getDisplayMedia) {
  $('compatibility').textContent = '当前设备可以加入和观看。共享屏幕建议使用电脑 Chrome / Edge。';
  $('compatibility').hidden = false;
}
fetch('/api/config').then((r) => {
  if (!r.ok) throw new Error();
  return r.json();
}).then((config) => {
  state.config = config;
  $('accessKeyRow').hidden = !config.accessKeyRequired;
  $('capacityNote').textContent = `每个房间最多 ${config.maxParticipants} 人，一次只共享一块屏幕。每个人都能语音。`;
}).catch(() => {
  $('compatibility').textContent = '暂时连不上房间服务，请检查服务器是否启动。';
  $('compatibility').hidden = false;
});
