import { PeerSession, PRESETS } from './rtc.js';
import { AudioMeters } from './audio-meter.js';

const $ = (id) => document.getElementById(id);
const state = {
  config: null, credentials: null, ws: null, selfId: null, epoch: 0,
  peers: new Map(), sessions: new Map(), peerStats: new Map(), ice: null, joined: false,
  micStream: null, screenStream: null, remoteVideos: new Map(),
  systemAudioMuted: false, busyMic: false, busyShare: false, stoppingShare: false,
  leaving: false, retry: 0, retryTimer: null, terminal: false,
  quality: 'economy', mediaRevision: 0, pending: new Map(),
  listenMuted: false, lobbyMode: 'create', trafficHistory: [], startedAt: 0,
};
let toastTimer;
let roomTimer;
let installPrompt;
const meters = new AudioMeters(renderLevels);

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`); svg.append(use);
  return svg;
}

function renderLevels(levels) {
  for (const member of document.querySelectorAll('.member[data-peer], #selfMember')) {
    const id = member.id === 'selfMember' ? 'self' : member.dataset.peer;
    const enabled = id === 'self' ? localState().mic : state.peers.get(id)?.mic;
    const sample = enabled ? levels.get(id) : null;
    member.classList.toggle('speaking', Boolean(sample?.speaking));
    const meter = member.querySelector('.voice-meter');
    meter?.setAttribute('aria-valuenow', String(Math.round((sample?.level || 0) * 100)));
    const count = Math.ceil((sample?.level || 0) * 12);
    meter?.querySelectorAll('i').forEach((bar, index) => bar.classList.toggle('lit', index < count));
    const label = member.querySelector('[data-voice-label]');
    if (label) label.textContent = sample?.speaking ? '正在说话' : enabled ? '麦克风开启' : '已静音';
  }
}

function renderPeerConnections() {
  const labels = { new: '连接中', connecting: '连接中', connected: '', disconnected: '连接中断', failed: '连接失败', closed: '连接关闭' };
  for (const member of $('membersList').querySelectorAll('.member[data-peer]')) {
    const connection = state.sessions.get(member.dataset.peer)?.pc.connectionState || 'new';
    const label = member.querySelector('[data-connection-label]');
    label.textContent = labels[connection] ?? '连接中';
    label.hidden = connection === 'connected';
    label.classList.toggle('warning', ['failed', 'disconnected'].includes(connection));
  }
}

function updateClock() {
  const seconds = state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;
  const hours = Math.floor(seconds / 3600);
  $('roomElapsed').textContent = `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function setLobbyMode(mode) {
  state.lobbyMode = mode;
  $('createFields').hidden = mode !== 'create';
  $('joinFields').hidden = mode !== 'join';
  $('inviteInput').disabled = mode !== 'join';
  $('inviteInput').required = mode === 'join';
  for (const name of ['create', 'join']) {
    $(`${name}Tab`).classList.toggle('selected', name === mode);
    $(`${name}Tab`).setAttribute('aria-pressed', String(name === mode));
  }
  $('joinTitle').textContent = mode === 'join' ? '朋友在等你。' : '朋友们，从这里集合。';
  $('joinSubtitle').textContent = mode === 'join' ? '输入昵称和邀请链接，一起进房间。' : '无需注册，房间随开随用。';
}

function updateAudioPlayback() {
  for (const element of $('remoteAudio').querySelectorAll('audio')) {
    const voice = element.dataset.kind === 'voice';
    element.volume = Number($(voice ? 'voiceVolume' : 'volume').value) / 100;
    element.muted = state.listenMuted || (!voice && !state.peers.get(element.dataset.peer)?.sharing);
  }
}

function setFocusMode(enabled) {
  $('room').classList.toggle('focus-mode', enabled);
  $('focusButton').setAttribute('aria-pressed', String(enabled));
  $('focusButton').setAttribute('aria-label', enabled ? '退出专注模式' : '进入专注模式');
  $('focusButton').title = enabled ? '退出专注模式（Esc）' : '专注模式';
}

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
  $('selfState').textContent = `${local.mic ? '麦克风开启' : '已静音'}${local.sharing ? ' · 正在共享' : ''}`;
  $('selfMicStatus').classList.toggle('muted', !local.mic);
  $('selfMicStatus').title = local.mic ? '麦克风开启' : '麦克风已关闭';
  const members = peers.map((peer) => {
    const item = document.createElement('div'); item.className = 'member'; item.dataset.peer = peer.id;
    const avatar = document.createElement('span'); avatar.className = 'avatar friend-avatar'; avatar.textContent = peer.name.slice(0, 1);
    const text = document.createElement('div'); text.className = 'member-copy';
    const name = document.createElement('strong'); name.textContent = peer.name;
    const status = document.createElement('small');
    const voice = document.createElement('span'); voice.dataset.voiceLabel = ''; voice.textContent = peer.mic ? '麦克风开启' : '已静音';
    status.append(voice);
    if (peer.sharing) status.append(document.createTextNode(' · 共享中'));
    const connection = document.createElement('small'); connection.dataset.connectionLabel = '';
    const meter = document.createElement('span'); meter.className = 'voice-meter';
    meter.setAttribute('role', 'meter'); meter.setAttribute('aria-label', `${peer.name} 的语音音量`);
    meter.setAttribute('aria-valuemin', '0'); meter.setAttribute('aria-valuemax', '100'); meter.setAttribute('aria-valuenow', '0');
    for (let i = 0; i < 12; i++) meter.append(document.createElement('i'));
    const indicator = document.createElement('span'); indicator.className = `member-status${peer.sharing ? ' sharer' : peer.mic ? '' : ' muted'}`;
    indicator.title = peer.sharing ? '正在共享屏幕' : peer.mic ? '麦克风开启' : '麦克风已关闭';
    indicator.append(icon(peer.sharing ? 'screen' : 'mic'));
    text.append(name, status, connection, meter); item.append(avatar, text, indicator);
    return item;
  });
  if (!members.length) {
    const empty = document.createElement('div'); empty.className = 'members-empty'; empty.append(icon('users'));
    const note = document.createElement('p'); note.textContent = '还差你的朋友们。分享邀请链接，叫 TA 进来吧。'; empty.append(note); members.push(empty);
  }
  $('membersList').replaceChildren(...members);
  renderPeerConnections();
  renderLevels(new Map());
  updateAudioPlayback();
  $('micLabel').textContent = state.busyMic ? '正在授权…' : local.mic ? '麦克风已开启' : '麦克风已关闭';
  $('micButton').setAttribute('aria-pressed', String(local.mic));
  $('micButton').title = local.mic ? '关闭麦克风' : '开启麦克风';
  $('micButton').classList.toggle('active', local.mic);
  $('micButton').disabled = state.busyMic || !state.credentials;
  $('listenButton').classList.toggle('active', !state.listenMuted);
  $('listenButton').setAttribute('aria-pressed', String(!state.listenMuted));
  $('listenButton').title = state.listenMuted ? '恢复收听' : '暂停收听所有声音（麦克风继续发送）';
  $('listenLabel').textContent = state.listenMuted ? '收听已暂停' : '收听已开启';
  $('shareLabel').textContent = state.busyShare ? '正在选择画面…' : local.sharing ? '停止共享' : friend?.sharing ? '朋友正在共享' : '共享屏幕';
  $('shareButton').classList.toggle('sharing', local.sharing);
  $('shareButton').disabled = state.busyShare || (!local.sharing && (!state.joined || Boolean(friend?.sharing)));
  $('emptyShareButton').disabled = $('shareButton').disabled;
  const hasAudio = Boolean(state.screenStream?.getAudioTracks().some((t) => t.readyState === 'live'));
  $('systemAudioButton').disabled = !hasAudio;
  $('systemAudioButton').setAttribute('aria-pressed', String(local.systemAudio));
  $('systemAudioButton').classList.toggle('active', local.systemAudio);
  $('systemAudioLabel').textContent = hasAudio ? local.systemAudio ? '声音已共享' : '共享声已静音' : '未共享声音';
  $('systemAudioButton').title = hasAudio ? '独立控制共享的电脑声音' : '先共享画面并在浏览器弹窗中勾选音频';

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
  $('stageStatus').textContent = local.sharing ? '你正在共享屏幕' : friend ? `${friend.name} 正在共享` : '等待共享画面';
  $('stageTitle').textContent = friend ? '画面正在连接…' : peers.length ? '大家都到齐了吗？开始吧。' : '把朋友们请进来吧。';
  $('stageHint').textContent = friend ? '保持页面打开，连接完成后就能看到画面。' : peers.length ? '点击「共享屏幕」，选一个画面和大家分享。' : '复制邀请链接，朋友加入后就能一起看、一起聊。';
  $('emptyInviteButton').hidden = Boolean(friend);
  $('emptyShareButton').hidden = Boolean(friend);
  $('fullscreenButton').disabled = !stream;
  const preset = PRESETS[state.quality];
  $('qualityHint').textContent = `每位观看者画面码率上限 ${(preset.bitrate / 1000000).toFixed(1)} Mbps。${peers.length ? `向 ${peers.length} 位传送时，画面总上传上限约 ${(preset.bitrate * peers.length / 1000000).toFixed(1)} Mbps。` : '默认适合网页和代码。'}`;
  if (state.screenStream) {
    const settings = track?.getSettings() || {};
    $('screenSpec').textContent = settings.width ? `${settings.width} × ${settings.height}` : preset.label;
  }
  renderStats();
}

function resetPeer(id) {
  meters.remove(id);
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
  state.trafficHistory.length = 0;
  $('uploadValue').textContent = $('downloadValue').textContent = $('latencyValue').textContent = '—';
  $('latencyHint').textContent = '等待测量';
  $('trafficLine').setAttribute('points', '');
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

function renderStats(recordSample = false) {
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
  $('roomConnection').textContent = !state.joined ? '正在重连' : failed ? '部分连接不稳' : sessions.length && connected < sessions.length ? '正在连接' : '已加入房间';
  $('roomConnection').classList.toggle('warning', !state.joined || failed);
  $('uploadValue').textContent = all.length ? sent.toFixed(2) : '—';
  $('downloadValue').textContent = all.length ? received.toFixed(2) : '—';
  $('latencyValue').textContent = rtt == null ? '—' : String(rtt);
  $('latencyHint').textContent = rtt == null ? '等待测量' : 'ms · 最慢连接';
  if (recordSample && all.length) {
    const now = Date.now();
    const sample = { time: now, value: sent + received };
    if (state.trafficHistory.length && now - state.trafficHistory.at(-1).time < 1500) state.trafficHistory[state.trafficHistory.length - 1] = sample;
    else state.trafficHistory.push(sample);
    state.trafficHistory = state.trafficHistory.filter((entry) => now - entry.time <= 60000).slice(-31);
    const max = Math.max(.1, ...state.trafficHistory.map((entry) => entry.value));
    $('trafficLine').setAttribute('points', state.trafficHistory.map((entry) => `${Math.max(0, 140 - (now - entry.time) / 60000 * 140).toFixed(1)},${(28 - entry.value / max * 24).toFixed(1)}`).join(' '));
  }
  renderPeerConnections();
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
        if (kind === 'voice') meters.add(id, element.srcObject);
        updateAudioPlayback();
        void playAudio();
      }
    },
    onState: (status) => {
      if (state.sessions.get(id) === session) renderStats();
    },
    onStats: (stats) => {
      if (state.sessions.get(id) !== session) return;
      state.peerStats.set(id, stats); renderStats(true);
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
  void meters.resume();
  await connectSocket();
  if (!state.credentials) return;
  history.replaceState(null, '', inviteLink());
  $('lobby').hidden = true; $('room').hidden = false;
  state.startedAt = Date.now();
  roomTimer = setInterval(updateClock, 1000); updateClock();
  document.title = '同屏房间 · 同屏 Lite';
  render();
  safeStorageSet('tongping-name', credentials.name);
  if ($('joinMic').checked) await enableMic();
  void playAudio();
}

async function enableMic() {
  if (state.busyMic || state.micStream) return;
  const revision = state.mediaRevision;
  state.busyMic = true; render();
  void meters.resume();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false,
    });
    if (revision !== state.mediaRevision || !state.credentials) { stream.getTracks().forEach((t) => t.stop()); return; }
    state.micStream = stream;
    meters.add('self', stream);
    stream.getAudioTracks()[0].onended = () => { void disableMic(); toast('麦克风已断开，可以重新开启。', true); };
    await Promise.all([...state.sessions.values()].map((session) => session.setTrack(0, stream.getAudioTracks()[0])));
    publishState();
  } catch (error) { toast(mediaError(error), true); }
  finally { state.busyMic = false; render(); }
}

async function disableMic() {
  meters.remove('self');
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
  clearInterval(roomTimer); state.startedAt = 0; updateClock();
  meters.clear();
  rejectPending();
  const socket = state.ws;
  state.ws = null; state.joined = false;
  socket?.close();
  state.micStream?.getTracks().forEach((t) => t.stop());
  state.screenStream?.getTracks().forEach((t) => t.stop());
  state.micStream = state.screenStream = null;
  state.peers.clear(); state.credentials = null; state.retry = 0;
  state.listenMuted = false;
  resetAllPeers();
  $('room').hidden = true; $('lobby').hidden = false;
  $('reconnectPrompt').hidden = true;
  $('inviteDialog').close();
  setFocusMode(false);
  document.title = '同屏 Lite · 一起看，一起聊';
  if (updateUrl) {
    history.replaceState(null, '', '/');
    $('inviteInput').value = '';
    setLobbyMode('create');
  }
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

function lobbyBusy(busy) {
  $('createButton').disabled = $('joinButton').disabled = busy;
  $('createTab').disabled = $('joinTab').disabled = busy;
  $('roomForm').setAttribute('aria-busy', String(busy));
  $('createLabel').textContent = busy && state.lobbyMode === 'create' ? '正在创建房间…' : '创建一个房间';
  $('joinLabel').textContent = busy && state.lobbyMode === 'join' ? '正在加入房间…' : '加入朋友的房间';
}

$('roomForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.lobbyMode === 'join') { $('joinButton').click(); return; }
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
  if (!$('displayName').reportValidity() || !$('inviteInput').reportValidity()) return;
  lobbyBusy(true);
  try { await enterRoom({ ...parseInvite($('inviteInput').value.trim()), name: $('displayName').value.trim() || '访客' }); }
  catch (error) { toast(mediaError(error), true); }
  finally { lobbyBusy(false); }
});
$('micButton').addEventListener('click', () => { void (state.micStream ? disableMic() : enableMic()).catch((error) => toast(mediaError(error), true)); });
$('shareButton').addEventListener('click', () => { void (state.screenStream ? stopShare() : startShare()); });
$('emptyShareButton').addEventListener('click', () => { void startShare(); });
$('listenButton').addEventListener('click', () => {
  state.listenMuted = !state.listenMuted;
  render();
  if (!state.listenMuted) { void meters.resume(); void playAudio(); }
});
$('systemAudioButton').addEventListener('click', () => {
  state.systemAudioMuted = !state.systemAudioMuted;
  state.screenStream?.getAudioTracks().forEach((t) => { t.enabled = !state.systemAudioMuted; });
  publishState();
});
$('volume').addEventListener('input', () => {
  updateAudioPlayback();
  $('volumeValue').textContent = `${$('volume').value}%`;
});
$('voiceVolume').addEventListener('input', () => {
  updateAudioPlayback();
  $('voiceVolumeValue').textContent = `${$('voiceVolume').value}%`;
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
$('sidebarInviteButton').addEventListener('click', () => { void copyInvite(); });
$('copyDialogLink').addEventListener('click', () => { void copyInvite(); });
$('closeInvite').addEventListener('click', () => $('inviteDialog').close());
$('resumeAudio').addEventListener('click', () => { void meters.resume(); void playAudio(); });
$('reconnectButton').addEventListener('click', () => { state.retry = 0; scheduleReconnect(); });
$('retryConnection').addEventListener('click', () => {
  if (!state.joined) { state.retry = 0; scheduleReconnect(); }
  else if (state.peers.size) { send({ type: 'ice-refresh' }); toast('正在重试语音与画面连接'); }
  else toast('朋友们加入后即可建立连接。');
});
$('createTab').addEventListener('click', () => setLobbyMode('create'));
$('joinTab').addEventListener('click', () => setLobbyMode('join'));
$('focusButton').addEventListener('click', () => setFocusMode(!$('room').classList.contains('focus-mode')));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setFocusMode(false); });
for (const id of ['helpButton', 'lobbyHelpButton', 'roomHelpButton']) $(id).addEventListener('click', () => $('helpDialog').showModal());
for (const id of ['closeHelp', 'helpDone']) $(id).addEventListener('click', () => $('helpDialog').close());
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault(); installPrompt = event;
  $('installButton').hidden = false;
});
$('installButton').addEventListener('click', async () => {
  if (!installPrompt) return;
  const prompt = installPrompt; installPrompt = null;
  $('installButton').hidden = true;
  try { await prompt.prompt(); await prompt.userChoice; }
  catch { toast('请从浏览器菜单中选择安装应用。'); }
});
window.addEventListener('appinstalled', () => { installPrompt = null; $('installButton').hidden = true; });
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Online screen sharing does not depend on application installation.
    });
  });
}
window.addEventListener('beforeunload', () => leaveRoom(false));
window.addEventListener('online', () => { if (state.credentials && !state.joined) { state.retry = 0; scheduleReconnect(); } });

$('displayName').value = safeStorageGet('tongping-name') || '';
if (location.pathname.startsWith('/r/')) {
  $('inviteInput').value = location.href;
  setLobbyMode('join');
} else setLobbyMode('create');
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
