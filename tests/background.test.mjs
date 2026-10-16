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
let misplaceNextWindow = false; // simulate Safari ignoring left/top
const browser = {
  storage: { session: area('session'), local: area('local') },
  runtime: { onMessage: { addListener: (f) => { onMessage = f; } } },
  windows: {
    create: async (o) => {
      if (o.type === 'popup') throw new Error('popup unsupported (simulated)');
      const id = ++winSeq, tid = ++tabSeq;
      const w = { id, left: misplaceNextWindow ? 0 : o.left, top: o.top, width: o.width, height: o.height, state: 'normal', tabs: [{ id: tid, windowId: id }] };
      misplaceNextWindow = false;
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

const inBg = (code) => vm.runInContext(code, ctx);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const call = (msg, tabId) => new Promise((res) => onMessage(msg, { tab: tabId ? tabs.get(tabId) : undefined }, res));
const ctrlScreen = { sw: 1800, sh: 1169, al: 0, at: 39, aw: 1800, ah: 1040, iw: 1800, ih: 1000 };
const tvScreen = { sw: 1920, sh: 1080, al: 1800, at: 0, aw: 1920, ah: 1080, iw: 1280, ih: 690 };

// hello from an unrelated tab
assert.equal((await call({ type: 'hello' }, 2)).role, null);

// start
const r = await call({ type: 'start', site: 'youtube', key: 'abc', url: 'https://www.youtube.com/watch?v=abc&t=42s', t: 42.5, screen: ctrlScreen }, 2);
assert.equal(r.ok, true, JSON.stringify(r));
const s = r.session;
assert.equal(s.controllerTabId, 2);
const w = windows.get(s.playerWindowId);
assert.equal(w.left, 1800, 'guessed TV to the right of the controller screen');
assert.equal((await call({ type: 'hello' }, 2)).role, 'controller');
assert.equal((await call({ type: 'hello' }, s.playerTabId)).role, 'player');

// player state from the TV screen → bounds remembered + window fullscreen attempted
tabHandlers[s.playerTabId] = (msg) => (msg.type === 'getState' ? { t: 99, key: 'abc' } : { ok: true, echo: msg });
const st = (t, extra = {}) => ({ seq: 1, sentAt: Date.now(), t, d: 600, paused: false, rate: 1, key: 'abc', screen: tvScreen, vis: 'visible', focus: false, ...extra });
assert.equal((await call({ type: 'state', state: st(43) }, s.playerTabId)).ok, true);
assert.ok(mem.local.tvBounds, 'TV bounds remembered');
assert.ok(sent.some((m) => m.id === 2 && m.msg.type === 'state'), 'state relayed to controller');
await sleep(2700);
assert.equal(windows.get(s.playerWindowId).state, 'fullscreen');
// The player never reports filling the screen here, so auto-fullscreen retries,
// and only the last failed attempt asks for a click.
assert.ok(!sent.some((m) => m.msg.type === 'needFullscreenClick'), 'first attempt is quiet');
for (let i = 2; i <= 3; i++) {
  inBg('S.fsLastAttemptAt = 0');
  await call({ type: 'state', state: st(43 + i) }, s.playerTabId);
  await sleep(2700);
}
assert.equal(inBg('S.fsAutoAttempts'), 3);
assert.equal(inBg('D.placement.windowFullscreen.focus'), true, 'later attempts bring the window forward');
assert.ok(sent.some((m) => m.msg.type === 'needFullscreenClick'), 'player asked for a click after the last attempt');
assert.ok(sent.some((m) => m.id === 2 && m.msg.type === 'event' && m.msg.name === 'fullscreen-needs-click'), 'controller told too');
inBg('S.fsLastAttemptAt = 0');
await call({ type: 'state', state: st(47) }, s.playerTabId);
assert.equal(inBg('S.fsAutoAttempts'), 3, 'no attempts beyond the limit');

// Remote fullscreen button: the player says which way to go.
const filled = { ...tvScreen, iw: 1920, ih: 1080 };
tabHandlers[s.playerTabId] = (msg) => (msg.type === 'getState' ? { t: 99, key: 'abc', screen: tvScreen } : { ok: true, echo: msg });
const exitRes = await call({ type: 'toggleWindowFullscreen', exit: true }, s.playerTabId);
assert.equal(windows.get(s.playerWindowId).state, 'normal');
assert.equal(exitRes.ok, true, 'left fullscreen');
sent.length = 0;
tabHandlers[s.playerTabId] = (msg) => (msg.type === 'getState' ? { t: 99, key: 'abc', screen: filled } : { ok: true, echo: msg });
const enterRes = await call({ type: 'toggleWindowFullscreen', exit: false }, s.playerTabId);
assert.equal(windows.get(s.playerWindowId).state, 'fullscreen');
assert.equal(enterRes.ok, true, 'entered fullscreen');
assert.ok(!sent.some((m) => m.msg.type === 'needFullscreenClick'), 'no click needed when it worked');
tabHandlers[s.playerTabId] = (msg) => (msg.type === 'getState' ? { t: 99, key: 'abc' } : { ok: true, echo: msg });

// Bridge injection reports a missing scripting API instead of throwing.
assert.equal((await call({ type: 'injectBridge' }, s.playerTabId)).ok, false);

// state from a non-player tab is rejected
assert.equal((await call({ type: 'state', state: st(1) }, 2)).stale, true);

// command relay
const c = await call({ type: 'cmd', action: 'seekBy', value: 10 }, 2);
assert.equal(c.echo.action, 'seekBy');
assert.ok(c.echo.id, 'commands carry an id');

// Direct delivery fails → queued, handed over with the next state report.
const realHandler = tabHandlers[s.playerTabId];
tabHandlers[s.playerTabId] = (msg) => { if (msg.type === 'cmd') throw new Error('Could not establish connection'); return realHandler(msg); };
const q = await call({ type: 'cmd', action: 'pause' }, 2);
assert.deepEqual({ ok: q.ok, queued: q.queued }, { ok: true, queued: true });
const stRes = await call({ type: 'state', state: st(50) }, s.playerTabId);
assert.equal(stRes.cmds.length, 1);
assert.equal(stRes.cmds[0].action, 'pause');
assert.equal((await call({ type: 'state', state: st(50.5) }, s.playerTabId)).cmds.length, 0, 'handed over once');
// A command left in the queue too long is dropped, not run late.
await call({ type: 'cmd', action: 'seekBy', value: 5 }, 2);
inBg('pendingCmds[0].queuedAt -= 5000');
assert.equal((await call({ type: 'state', state: st(51) }, s.playerTabId)).cmds.length, 0);
const dc = (await call({ type: 'diag:get' })).diag.commands;
assert.equal(dc.queued, 2);
assert.equal(dc.expired, 1);
assert.equal(dc.failures.at(-1).error, 'Could not establish connection');
tabHandlers[s.playerTabId] = realHandler;
await call({ type: 'cmd', action: 'load', value: { key: 'xyz', url: 'https://www.youtube.com/watch?v=xyz', t: 0 } }, 2);
assert.equal((await call({ type: 'hello' }, s.playerTabId)).session.key, 'xyz');

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

// restart uses remembered bounds, and a window Safari put elsewhere is moved back
misplaceNextWindow = true;
const r2 = await call({ type: 'start', site: 'youtube', key: 'abc', url: 'https://www.youtube.com/watch?v=abc', t: 0, screen: ctrlScreen }, 2);
assert.equal(r2.session.ctrlScreen.sw, 1800);
assert.equal(windows.get(r2.session.playerWindowId).left, 0);
await sleep(1700);
assert.equal(windows.get(r2.session.playerWindowId).left, mem.local.tvBounds.left, 'moved to the remembered spot');
// closing the player tab manually ends the session
sent.length = 0;
tabs.delete(r2.session.playerTabId);
await onRemoved(r2.session.playerTabId);
assert.ok(sent.some((m) => m.id === 2 && m.msg.type === 'session-ended' && m.msg.reason === 'player-closed'));

console.log('background tests passed');
