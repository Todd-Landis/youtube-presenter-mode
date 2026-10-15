// Drives background.js with mocked Safari extension APIs.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const mem = { session: {}, local: {} };
const area = (k) => ({
  get: async (key) => (key in mem[k] ? { [key]: structuredClone(mem[k][key]) } : {}),
  set: async (obj) => { Object.assign(mem[k], structuredClone(obj)); },
  remove: async (key) => { delete mem[k][key]; },
});
const tabs = new Map([[2, { id: 2, windowId: 1 }]]);
const windows = new Map();
const sent = [];
const tabHandlers = {};
let onMessage, onRemoved, onCommand;
let winSeq = 10, tabSeq = 100;
const browser = {
  storage: { session: area('session'), local: area('local') },
  runtime: { onMessage: { addListener: (f) => { onMessage = f; } } },
  windows: {
    create: async (o) => {
      if (o.type === 'popup') throw new Error('popup unsupported (simulated)');
      const id = ++winSeq, tid = ++tabSeq;
      const w = { id, left: o.left, top: o.top, width: o.width, height: o.height, state: 'normal', tabs: [{ id: tid, windowId: id }] };
      windows.set(id, w); tabs.set(tid, { id: tid, windowId: id });
      return w;
    },
    get: async (id) => { if (!windows.has(id)) throw new Error('no window'); return windows.get(id); },
    update: async (id, o) => { Object.assign(windows.get(id), o); return windows.get(id); },
    remove: async (id) => { const w = windows.get(id); windows.delete(id); for (const t of w.tabs) { tabs.delete(t.id); onRemoved?.(t.id); } },
  },
  tabs: {
    get: async (id) => { if (!tabs.has(id)) throw new Error('no tab'); return tabs.get(id); },
    query: async () => [tabs.get(2)],
    sendMessage: async (id, msg) => { sent.push({ id, msg }); return tabHandlers[id]?.(msg) ?? { ok: true }; },
    onRemoved: { addListener: (f) => { onRemoved = f; } },
    onUpdated: { addListener: () => {} },
  },
  commands: { onCommand: { addListener: (f) => { onCommand = f; } } },
};
const ctx = vm.createContext({ browser, console, setTimeout, clearTimeout, URL, navigator: { userAgent: 'node-test' }, structuredClone });
vm.runInContext(src, ctx);

const call = (msg, tabId) => new Promise((res) => onMessage(msg, { tab: tabId ? tabs.get(tabId) : undefined }, res));
const ctrlScreen = { sw: 1800, sh: 1169, al: 0, at: 39, aw: 1800, ah: 1040, iw: 1800, ih: 1000 };
const tvScreen = { sw: 1920, sh: 1080, al: 1800, at: 0, aw: 1920, ah: 1080, iw: 1280, ih: 690 };

// hello from an unrelated tab
assert.equal((await call({ type: 'hello' }, 2)).role, null);

// start
const r = await call({ type: 'start', videoId: 'abc', t: 42.5, screen: ctrlScreen }, 2);
assert.equal(r.ok, true, JSON.stringify(r));
const s = r.session;
assert.equal(s.controllerTabId, 2);
const w = windows.get(s.playerWindowId);
assert.equal(w.left, 1800, 'guessed TV to the right of the controller screen');
assert.equal((await call({ type: 'hello' }, 2)).role, 'controller');
assert.equal((await call({ type: 'hello' }, s.playerTabId)).role, 'player');

// player state from the TV screen → bounds remembered + window fullscreen attempted
tabHandlers[s.playerTabId] = (msg) => (msg.type === 'getState' ? { t: 99, videoId: 'abc' } : { ok: true, echo: msg });
const st = (t, extra = {}) => ({ seq: 1, sentAt: Date.now(), t, d: 600, paused: false, rate: 1, videoId: 'abc', screen: tvScreen, vis: 'visible', focus: false, ...extra });
assert.equal((await call({ type: 'state', state: st(43) }, s.playerTabId)).ok, true);
assert.ok(mem.local.tvBounds, 'TV bounds remembered');
assert.ok(sent.some((m) => m.id === 2 && m.msg.type === 'state'), 'state relayed to controller');
await new Promise((res) => setTimeout(res, 2700));
assert.equal(windows.get(s.playerWindowId).state, 'fullscreen');
assert.ok(sent.some((m) => m.msg.type === 'needFullscreenClick'), 'player asked for a click since it still did not fill the screen');
assert.ok(sent.some((m) => m.id === 2 && m.msg.type === 'event' && m.msg.name === 'fullscreen-needs-click'), 'controller told too');

// Remote fullscreen button: the player says which way to go.
const filled = { ...tvScreen, iw: 1920, ih: 1080 };
tabHandlers[s.playerTabId] = (msg) => (msg.type === 'getState' ? { t: 99, videoId: 'abc', screen: tvScreen } : { ok: true, echo: msg });
const exitRes = await call({ type: 'toggleWindowFullscreen', exit: true }, s.playerTabId);
assert.equal(windows.get(s.playerWindowId).state, 'normal');
assert.equal(exitRes.ok, true, 'left fullscreen');
sent.length = 0;
tabHandlers[s.playerTabId] = (msg) => (msg.type === 'getState' ? { t: 99, videoId: 'abc', screen: filled } : { ok: true, echo: msg });
const enterRes = await call({ type: 'toggleWindowFullscreen', exit: false }, s.playerTabId);
assert.equal(windows.get(s.playerWindowId).state, 'fullscreen');
assert.equal(enterRes.ok, true, 'entered fullscreen');
assert.ok(!sent.some((m) => m.msg.type === 'needFullscreenClick'), 'no click needed when it worked');
tabHandlers[s.playerTabId] = (msg) => (msg.type === 'getState' ? { t: 99, videoId: 'abc' } : { ok: true, echo: msg });

// Bridge injection reports a missing scripting API instead of throwing.
assert.equal((await call({ type: 'injectBridge' }, s.playerTabId)).ok, false);

// state from a non-player tab is rejected
assert.equal((await call({ type: 'state', state: st(1) }, 2)).stale, true);

// command relay
const c = await call({ type: 'cmd', action: 'seekBy', value: 10 }, 2);
assert.equal(c.echo.action, 'seekBy');
await call({ type: 'cmd', action: 'load', value: { videoId: 'xyz', t: 0 } }, 2);
assert.equal((await call({ type: 'hello' }, s.playerTabId)).session.videoId, 'xyz');

// diagnostics
const d = await call({ type: 'diag:get' });
assert.ok(d.diag.placement.createErrors.length === 1, 'popup failure recorded, then fell back');
assert.equal(d.diag.placement.playerOnOtherScreen, true);

// end → final state from player, window removed, controller told
const e = await call({ type: 'end', reason: 'user' }, 2);
assert.equal(e.final.t, 99);
assert.ok(!windows.has(s.playerWindowId));
assert.ok(sent.some((m) => m.id === 2 && m.msg.type === 'session-ended'));
assert.equal((await call({ type: 'hello' }, 2)).role, null);

// restart uses remembered bounds; closing the player tab manually ends the session
const r2 = await call({ type: 'start', videoId: 'abc', t: 0, screen: ctrlScreen }, 2);
assert.equal(r2.session.ctrlScreen.sw, 1800);
assert.equal(windows.get(r2.session.playerWindowId).left, mem.local.tvBounds.left);
sent.length = 0;
tabs.delete(r2.session.playerTabId);
await onRemoved(r2.session.playerTabId);
assert.ok(sent.some((m) => m.id === 2 && m.msg.type === 'session-ended' && m.msg.reason === 'player-closed'));

console.log('background tests passed');
