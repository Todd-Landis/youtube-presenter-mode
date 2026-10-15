// Background: owns the single presenter session (one controller tab, one player
// window), relays commands and state between them, and records the
// diagnostics. Safari may unload this page when idle, so the session lives in
// storage and is reloaded lazily.
'use strict';
const ext = globalThis.browser ?? globalThis.chrome;
const sessionStore = ext.storage.session ?? ext.storage.local;

const DEFAULT_SETTINGS = { mode: 'extended', autoFullscreen: true, windowType: 'popup' };
const YT_URL = /^https:\/\/(www\.)?youtube\.com\//;

let S; // session; undefined = not loaded yet, null = none
let lastState = null;
let D; // diagnostics
let diagSaveTimer = null;
const hb = { lastAt: 0, prev: null }; // heartbeat tracking (in-memory only)

// ---- storage ------------------------------------------------------------------

async function loadSession() {
  if (S !== undefined) return S;
  const r = await sessionStore.get('session');
  S = r.session ?? null;
  if (S) {
    try {
      await ext.tabs.get(S.playerTabId);
      await ext.tabs.get(S.controllerTabId);
    } catch {
      S = null;
      await sessionStore.remove('session');
    }
  }
  return S;
}

async function saveSession() {
  if (S) await sessionStore.set({ session: S });
  else await sessionStore.remove('session');
}

async function getSettings() {
  const r = await ext.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(r.settings || {}) };
}

const DIAG_VERSION = 3;

const newDiag = () => ({
  version: DIAG_VERSION,
  createdAt: Date.now(),
  env: { userAgent: navigator.userAgent },
  placement: {},
  playback: { msgs: 0, playingSec: 0, maxGapMs: 0, maxTickGapMs: 0, droppedFrames: 0, gaps: [], stalls: [], visibility: [] },
  controls: {},
  commands: { direct: 0, retried: 0, queued: 0, expired: 0, failures: [] },
  airplay: { connects: 0, drops: 0, events: [] },
  log: [],
});

async function loadDiag() {
  if (D) return D;
  const r = await ext.storage.local.get('diag');
  // Start over if the saved diagnostics predate the current layout.
  D = r.diag?.version === DIAG_VERSION ? r.diag : newDiag();
  return D;
}

function saveDiagSoon() {
  if (diagSaveTimer) return;
  diagSaveTimer = setTimeout(async () => {
    diagSaveTimer = null;
    if (D) await ext.storage.local.set({ diag: D });
  }, 3000);
}

function push(arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

async function log(src, msg, data) {
  await loadDiag();
  push(D.log, { at: Date.now(), src, msg, data: data ?? null }, 300);
  saveDiagSoon();
}

// ---- helpers ------------------------------------------------------------------------

const pickWin = (w) => w && { id: w.id, left: w.left, top: w.top, width: w.width, height: w.height, state: w.state, type: w.type, focused: w.focused };
const sameScreen = (a, b) => !!a && !!b && a.sw === b.sw && a.sh === b.sh && a.al === b.al && a.at === b.at;
const fillsScreen = (s) => !!s && s.iw >= s.sw - 2 && s.ih >= s.sh - 2;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function watchUrl({ videoId, list, index, t }) {
  const u = new URL('https://www.youtube.com/watch');
  u.searchParams.set('v', videoId);
  if (list) u.searchParams.set('list', list);
  if (index) u.searchParams.set('index', index);
  if (t > 1) u.searchParams.set('t', Math.floor(t) + 's');
  u.hash = 'ytpm-player';
  return u.href;
}

function toTab(tabId, msg) {
  return ext.tabs.sendMessage(tabId, msg).catch(() => null);
}

// Like toTab, but keeps Safari's reason when a message doesn't get through.
async function sendToTab(tabId, msg) {
  try {
    const r = await ext.tabs.sendMessage(tabId, msg);
    return r == null ? { r: null, error: 'empty response' } : { r, error: null };
  } catch (e) {
    return { r: null, error: String(e?.message || e) };
  }
}

// Commands that couldn't be delivered directly. The player collects them in
// the reply to its next state report (every 500 ms), a channel that keeps
// working when tabs.sendMessage doesn't.
const QUEUED_CMD_TTL_MS = 4000;
let pendingCmds = [];
let cmdSeq = 0;

// ---- session lifecycle -----------------------------------------------------------

async function startSession(msg, tab) {
  if (await loadSession()) await endSession('replaced');
  const settings = await getSettings();
  await loadDiag();
  const ctrl = msg.screen || {};
  const { tvBounds } = await ext.storage.local.get('tvBounds');

  let bounds;
  if (settings.mode === 'airplay') {
    // The player stays on the Mac's screen; it only needs to be clickable once.
    bounds = { left: (ctrl.al ?? 0) + Math.max(0, Math.round((ctrl.aw - 960) / 2)), top: (ctrl.at ?? 0) + 80, width: 960, height: 540 };
  } else {
    // First run: guess the TV is to the right of this screen. Once the window
    // has been on the TV, its spot is remembered (tvBounds).
    bounds = tvBounds ?? { left: (ctrl.al ?? 0) + ctrl.sw, top: ctrl.at ?? 0, width: 1280, height: 720 };
  }

  const url = watchUrl(msg);
  const attempts = [
    { url, ...bounds, type: settings.windowType, focused: settings.mode === 'airplay' },
    { url, ...bounds },
    { url },
  ];
  let win = null;
  const errors = [];
  for (const opts of attempts) {
    try {
      win = await ext.windows.create(opts);
      break;
    } catch (e) {
      errors.push({ opts: { ...opts, url: undefined }, error: String(e?.message || e) });
    }
  }
  if (!win) return { ok: false, error: 'windows.create failed: ' + errors.map((e) => e.error).join('; ') };

  const playerTab = win.tabs?.[0] ?? (await ext.tabs.query({ windowId: win.id }))[0];
  S = {
    id: Math.random().toString(36).slice(2, 10),
    mode: settings.mode,
    videoId: msg.videoId,
    startT: msg.t || 0,
    controllerTabId: tab.id,
    controllerWindowId: tab.windowId,
    playerTabId: playerTab.id,
    playerWindowId: win.id,
    ctrlScreen: ctrl,
    startedAt: Date.now(),
    onOther: false,
    fsAutoAttempts: 0,
    fsLastAttemptAt: 0,
    boundsSaved: false,
  };
  lastState = null;
  pendingCmds = [];
  hb.lastAt = 0;
  hb.prev = null;
  await saveSession();

  D.placement = {
    mode: settings.mode,
    requested: bounds,
    requestedType: settings.windowType,
    createErrors: errors,
    created: pickWin(win),
    controllerScreen: ctrl,
    rememberedBoundsUsed: !!tvBounds && settings.mode !== 'airplay',
  };
  log('bg', 'session started', { mode: settings.mode, videoId: msg.videoId, t: msg.t });
  // Where did Safari actually put it? If it ignored the position, move it.
  delay(1500).then(async () => {
    try {
      const w = await ext.windows.get(win.id);
      D.placement.after1500ms = pickWin(w);
      const off = Math.abs(w.left - bounds.left) > 40 || Math.abs(w.top - bounds.top) > 40;
      if (off && w.state !== 'fullscreen') {
        await ext.windows.update(win.id, bounds);
        D.placement.moved = pickWin(await ext.windows.get(win.id));
        log('bg', 'moved player window to the requested spot', D.placement.moved);
      }
    } catch {}
    saveDiagSoon();
  });
  return { ok: true, session: S };
}

async function endSession(reason) {
  const s = await loadSession();
  if (!s) return { ok: true, final: lastState };
  let final = lastState;
  if (reason !== 'player-closed') {
    const fresh = await toTab(s.playerTabId, { type: 'getState' });
    if (fresh && typeof fresh.t === 'number') final = fresh;
  }
  S = null;
  await saveSession();
  if (reason !== 'player-closed') {
    try { await ext.windows.remove(s.playerWindowId); } catch {}
  }
  toTab(s.controllerTabId, { type: 'session-ended', reason, final });
  log('bg', 'session ended', { reason, durationSec: Math.round((Date.now() - s.startedAt) / 1000) });
  return { ok: true, final };
}

// ---- player state: relay + placement/playback measurements ----------------------------

function heartbeat(state) {
  const now = Date.now();
  const s2 = D.playback;
  s2.msgs++;
  if (hb.lastAt) {
    const gap = now - hb.lastAt;
    s2.maxGapMs = Math.max(s2.maxGapMs, gap);
    if (gap > 1500) {
      push(s2.gaps, { at: now, gapMs: gap, vis: state.vis, focus: state.focus, paused: state.paused, wireless: state.wireless }, 50);
    }
  }
  if (state.tickGap) s2.maxTickGapMs = Math.max(s2.maxTickGapMs, state.tickGap);
  const prev = hb.prev;
  if (prev && prev.videoId === state.videoId) {
    if (prev.vis !== state.vis) push(s2.visibility, { at: now, vis: state.vis, focus: state.focus }, 50);
    if (state.frames && prev.frames && state.frames.dropped >= prev.frames.dropped) {
      s2.droppedFrames += state.frames.dropped - prev.frames.dropped;
    }
    const wall = (state.sentAt - prev.sentAt) / 1000;
    const media = state.t - prev.t;
    const playing = !state.paused && !prev.paused && !state.ended;
    // Ignore seeks (big jumps either way).
    if (playing && wall > 0 && media > -0.5 && media < wall * state.rate + 3) {
      s2.playingSec += wall;
      if (wall > 1 && media < wall * state.rate * 0.5) {
        push(s2.stalls, { at: now, wallSec: +wall.toFixed(2), mediaSec: +media.toFixed(2), vis: state.vis, focus: state.focus, wireless: state.wireless }, 50);
      }
    }
  }
  hb.prev = state;
  hb.lastAt = now;
}

async function trackScreen(state, settings) {
  const other = !sameScreen(state.screen, S.ctrlScreen);
  D.placement.playerScreen = state.screen;
  D.placement.playerOnOtherScreen = other;
  if (other !== S.onOther) {
    S.onOther = other;
    if (other) S.fsAutoAttempts = 0;
    await saveSession();
    log('player', other ? 'player window is on another screen' : 'player window is on the controller screen', state.screen);
  }
  if (!other) return;

  if (!S.boundsSaved && !fillsScreen(state.screen)) {
    S.boundsSaved = true;
    try {
      const w = await ext.windows.get(S.playerWindowId);
      if (w.state !== 'fullscreen') {
        await ext.storage.local.set({ tvBounds: { left: w.left, top: w.top, width: w.width, height: w.height } });
        log('bg', 'remembered TV window position', pickWin(w));
      }
    } catch {}
  }
  // Safari can ignore a fullscreen request made while the page is still
  // loading, so try a few times, bringing the window forward after the first.
  const n = S.fsAutoAttempts || 0;
  if (settings.autoFullscreen && n < AUTO_FS_ATTEMPTS && !fsInFlight && !fillsScreen(state.screen) && !state.fs &&
      Date.now() - (S.fsLastAttemptAt || 0) > 4000) {
    S.fsAutoAttempts = n + 1;
    S.fsLastAttemptAt = Date.now();
    await saveSession();
    tryWindowFullscreen('auto #' + (n + 1), false, { focus: n > 0, quiet: n + 1 < AUTO_FS_ATTEMPTS });
  }
}

const AUTO_FS_ATTEMPTS = 3;
let fsInFlight = false;

// Native window fullscreen needs no user gesture and survives page loads,
// unlike element fullscreen. If Safari ignores it, the player asks for a click.
async function tryWindowFullscreen(trigger, toNormal = false, { focus = false, quiet = false } = {}) {
  const s = await loadSession();
  if (!s) return { ok: false };
  await loadDiag();
  fsInFlight = true;
  const r = { at: Date.now(), trigger, target: toNormal ? 'normal' : 'fullscreen', focus };
  try {
    if (focus) await ext.windows.update(s.playerWindowId, { focused: true });
    await ext.windows.update(s.playerWindowId, { state: toNormal ? 'normal' : 'fullscreen' });
    r.call = 'ok';
  } catch (e) {
    r.call = 'threw: ' + (e?.message || e);
  }
  await delay(2500);
  fsInFlight = false;
  // Hand keyboard focus back to the controller so shortcuts keep working.
  if (focus) ext.windows.update(s.controllerWindowId, { focused: true }).catch(() => {});
  try { r.windowStateAfter = (await ext.windows.get(s.playerWindowId)).state; } catch {}
  // Ask the player directly; the last relayed state can be stale.
  const fresh = await toTab(s.playerTabId, { type: 'getState' });
  const fills = fillsScreen((fresh ?? lastState)?.screen) || !!fresh?.fs;
  r.playerFillsScreenAfter = fills;
  r.ok = toNormal ? !fills : fills;
  D.placement.windowFullscreen = r;
  log('bg', 'window ' + r.target + (r.ok ? ' worked' : ' did not take'), r);
  if (!toNormal && !fills && !quiet) {
    toTab(s.playerTabId, { type: 'needFullscreenClick' });
    toTab(s.controllerTabId, { type: 'event', name: 'fullscreen-needs-click' });
  }
  return r;
}

async function onPlayerState(state, sender) {
  await loadSession();
  if (!S || sender.tab?.id !== S.playerTabId) return { ok: false, stale: true };
  await loadDiag();
  lastState = state;
  heartbeat(state);
  if (state.bridge) D.controls.bridge = state.bridge;
  const settings = await getSettings();
  if (S.mode === 'extended') await trackScreen(state, settings);
  toTab(S.controllerTabId, { type: 'state', state, session: S });
  saveDiagSoon();
  // Hand over any commands that couldn't be delivered directly.
  const now = Date.now();
  const fresh = pendingCmds.filter((c) => now - c.queuedAt < QUEUED_CMD_TTL_MS);
  D.commands.expired += pendingCmds.length - fresh.length;
  pendingCmds = [];
  return { ok: true, cmds: fresh };
}

async function onPlayerEvent(msg, sender) {
  await loadSession();
  await loadDiag();
  const entry = { at: Date.now(), name: msg.name, data: msg.data };
  if (msg.name.startsWith('airplay') || msg.name.startsWith('remote-playback') || msg.name === 'video-bound') {
    push(D.airplay.events, entry, 100);
    if (msg.name === 'airplay-connected') D.airplay.connects++;
    if (msg.name === 'airplay-disconnected') D.airplay.drops++;
  }
  if (msg.name === 'selftest') D.controls.selftest = msg.data;
  log('player', msg.name, msg.data);
  if (msg.notify && S && sender.tab?.id === S.playerTabId) {
    toTab(S.controllerTabId, { type: 'event', name: msg.name, data: msg.data });
  }
  return { ok: true };
}

// ---- message router ----------------------------------------------------------------------

async function handle(msg, sender) {
  switch (msg.type) {
    case 'hello': {
      const s = await loadSession();
      const tabId = sender.tab?.id;
      const role = !s ? null : tabId === s.playerTabId ? 'player' : tabId === s.controllerTabId ? 'controller' : null;
      return { role, session: role ? s : null, settings: await getSettings() };
    }
    case 'start':
      return startSession(msg, sender.tab);
    case 'end':
      return endSession(msg.reason || 'user');
    case 'state':
      return onPlayerState(msg.state, sender);
    case 'event':
      return onPlayerEvent(msg, sender);
    case 'cmd': {
      const s = await loadSession();
      if (!s) return { ok: false, error: 'no active session' };
      if (msg.action === 'load' && msg.value?.videoId) {
        // A full page load in the player re-reads startT on hello.
        s.videoId = msg.value.videoId;
        s.startT = msg.value.t || 0;
        await saveSession();
      }
      await loadDiag();
      const cmd = { type: 'cmd', id: Date.now().toString(36) + '-' + ++cmdSeq, action: msg.action, value: msg.value };
      let { r, error } = await sendToTab(s.playerTabId, cmd);
      if (r) { D.commands.direct++; return r; }
      // One quick retry; the player ignores a command ID it has already run.
      await delay(150);
      const firstError = error;
      ({ r, error } = await sendToTab(s.playerTabId, cmd));
      if (r) { D.commands.retried++; return r; }
      pendingCmds.push({ ...cmd, queuedAt: Date.now() });
      D.commands.queued++;
      push(D.commands.failures, {
        at: Date.now(), action: msg.action, error: firstError, retryError: error,
        msSincePlayerState: hb.lastAt ? Date.now() - hb.lastAt : null,
        playerVis: lastState?.vis ?? null, playerFocus: lastState?.focus ?? null,
      }, 50);
      saveDiagSoon();
      return { ok: true, queued: true };
    }
    case 'toggleWindowFullscreen': {
      const s = await loadSession();
      if (!s) return { ok: false };
      // The player reports whether it fills its screen. Safari's window.state
      // isn't a reliable signal for native fullscreen.
      let exit = msg.exit;
      if (typeof exit !== 'boolean') {
        try { exit = (await ext.windows.get(s.playerWindowId)).state === 'fullscreen'; } catch { exit = false; }
      }
      // The user has taken over; stop automatic attempts.
      s.fsAutoAttempts = AUTO_FS_ATTEMPTS;
      await saveSession();
      return tryWindowFullscreen('remote', exit);
    }
    case 'injectBridge': {
      if (!ext.scripting?.executeScript || !sender.tab) return { ok: false, error: 'scripting API unavailable' };
      await ext.scripting.executeScript({ target: { tabId: sender.tab.id }, files: ['content/page-bridge.js'], world: 'MAIN' });
      return { ok: true };
    }
    case 'focusPlayer': {
      const s = await loadSession();
      if (s) await ext.windows.update(s.playerWindowId, { focused: true }).catch(() => {});
      return { ok: !!s };
    }
    case 'popup:status': {
      return { session: await loadSession(), lastState, settings: await getSettings() };
    }
    case 'popup:start': {
      const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
      if (!tab) return { ok: false, error: 'no active tab' };
      return (await toTab(tab.id, { type: 'start-request' })) ?? { ok: false, error: 'Open a YouTube video tab first (reload it if it was open before the extension was installed).' };
    }
    case 'popup:end':
      return endSession('popup');
    case 'settings:set': {
      const settings = { ...(await getSettings()), ...msg.settings };
      await ext.storage.local.set({ settings });
      return { ok: true, settings };
    }
    case 'diag:get':
      return { diag: await loadDiag(), session: await loadSession(), lastState, settings: await getSettings(), tvBounds: (await ext.storage.local.get('tvBounds')).tvBounds ?? null };
    case 'diag:reset':
      D = newDiag();
      hb.lastAt = 0;
      hb.prev = null;
      await ext.storage.local.set({ diag: D });
      return { ok: true };
    case 'diag:selftest': {
      const s = await loadSession();
      if (!s) return { ok: false, error: 'Start presenter mode first.' };
      return (await toTab(s.playerTabId, { type: 'selftest' })) ?? { ok: false, error: 'player window did not answer' };
    }
    case 'diag:forgetTv':
      await ext.storage.local.remove('tvBounds');
      return { ok: true };
  }
  return { ok: false, error: 'unknown message ' + msg.type };
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

// ---- tab/window lifecycle --------------------------------------------------------------

ext.tabs.onRemoved.addListener(async (tabId) => {
  const s = await loadSession();
  if (!s) return;
  if (tabId === s.playerTabId) {
    await endSession('player-closed');
  } else if (tabId === s.controllerTabId) {
    // Leave the player running as a normal YouTube window.
    S = null;
    await saveSession();
    toTab(s.playerTabId, { type: 'orphaned' });
    log('bg', 'controller tab closed; player window released');
  }
});

ext.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url || YT_URL.test(info.url)) return;
  const s = await loadSession();
  if (!s) return;
  if (tabId === s.playerTabId) await endSession('player-closed');
  else if (tabId === s.controllerTabId) {
    S = null;
    await saveSession();
    toTab(s.playerTabId, { type: 'orphaned' });
    log('bg', 'controller tab left YouTube; player window released');
  }
});

ext.commands?.onCommand.addListener(async (command) => {
  if (command !== 'toggle-presenter') return;
  if (await loadSession()) return void endSession('shortcut');
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (tab) toTab(tab.id, { type: 'start-request' });
});
