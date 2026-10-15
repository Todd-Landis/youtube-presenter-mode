// Full-system test harness: runs the real background.js and content scripts
// against simulated Safari extension APIs and simulated YouTube pages, with
// knobs for the failures seen (or feared) in real Safari: dropped or delayed
// messages, a background page that gets unloaded, fullscreen requests that are
// ignored, tabs that close or reload, and a TV display that disconnects.
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = fileURLToPath(new URL('../extension/', import.meta.url));
const read = (f) => fs.readFileSync(ROOT + f, 'utf8');
const SRC = {
  background: read('background.js'),
  bridge: read('content/page-bridge.js'),
  content: ['content/common.js', 'content/player.js', 'content/controller.js', 'content/boot.js'].map(read).join('\n'),
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const NO_CONNECTION = 'Could not establish connection. Receiving end does not exist.';

// Small seeded PRNG so failures are reproducible.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SCREENS = {
  mac: { x: 0, y: 0, w: 1800, h: 1169, menu: 39 },
  tv: { x: 1800, y: 0, w: 1920, h: 1080, menu: 25 },
};

export const CATALOG = {
  vidAlpha001: { title: 'Alpha', d: 300 },
  vidBravo002: { title: 'Bravo', d: 200 },
  vidCharl003: { title: 'Charlie', d: 120 },
  vidShort004: { title: 'Short one', d: 30 },
  vidLiveS005: { title: 'Live stream', live: true },
  vidError006: { title: '', error: 'auth' },
};
const NEXT = { vidAlpha001: 'vidBravo002', vidBravo002: 'vidCharl003', vidCharl003: 'vidAlpha001' };

function videoIdOf(url) {
  const u = new URL(url);
  const m = u.pathname.match(/^\/(?:shorts|live)\/([\w-]+)/);
  return m ? m[1] : u.searchParams.get('v');
}

// ---------------------------------------------------------------------------

export class World {
  constructor(opts = {}) {
    this.o = {
      seed: 1,
      bridge: true, // page-world bridge loads (false = Safari-style failure, DOM fallbacks)
      scripting: false, // scripting.executeScript({world: MAIN}) works
      fullscreen: 'works', // windows.update({state:'fullscreen'}): 'works' | 'ignored' | 'afterLoad'
      // While a window moves into or out of a fullscreen Space, WebKit can
      // briefly report the main display as its screen.
      fsGlitchMs: 500,
      // A fullscreen request on a window that is already fullscreen toggles
      // it back out (a naive toggleFullScreen: implementation).
      fsToggles: true,
      dropToTab: 0, // chance tabs.sendMessage fails
      dropReplyToTab: 0, // chance the tab ran the message but the reply was lost
      dropToBg: 0, // chance runtime.sendMessage from a page fails
      delay: [0, 15], // per-hop message delay range, ms
      loadDelay: [150, 350], // new window → content scripts running
      autoplay: true, // Safari lets the player autoplay with sound
      aboutBlank: true, // new windows report about:blank before the real URL
      popupType: true, // windows.create accepts type: 'popup'
      misplace: false, // Safari ignores left/top on create
      ...opts,
    };
    this.rand = rng(this.o.seed);
    this.storage = { session: {}, local: {} };
    this.tabs = new Map();
    this.windows = new Map();
    this.ids = { win: 10, tab: 100 };
    this.errors = [];
    this.focusLog = [];
    this.bgGen = 0;
    this.tvConnected = true;
    // jsdom keeps running a page's pending code after it closes (a real
    // browser stops it), so errors from closed pages are not counted.
    this.closedPages = new Set();
    this.onUnhandled = (e) => {
      const stack = String(e?.stack || e);
      if ([...this.closedPages].some((n) => stack.includes(n + '.js'))) return;
      this.errors.push('unhandled rejection: ' + stack);
    };
    process.on('unhandledRejection', this.onUnhandled);
    this.startBackground();
  }

  async dispose() {
    for (const t of this.tabs.values()) t.page?.close();
    this.bgGen++;
    await sleep(20);
    process.off('unhandledRejection', this.onUnhandled);
  }

  // ---- network --------------------------------------------------------------

  hop() {
    const [lo, hi] = this.o.delay;
    return sleep(lo + Math.floor(this.rand() * (hi - lo + 1)));
  }

  async deliverToTab(tabId, msg) {
    await this.hop();
    const page = this.tabs.get(tabId)?.page;
    if (!page?.listener || this.rand() < this.o.dropToTab) throw new Error(NO_CONNECTION);
    const res = await page.receive(clone(msg));
    await this.hop();
    if (this.rand() < this.o.dropReplyToTab) throw new Error('The message port closed before a response was received.');
    return clone(res);
  }

  async deliverToBg(tab, msg) {
    await this.hop();
    if (this.rand() < this.o.dropToBg) throw new Error(NO_CONNECTION);
    const listener = this.bgListeners.onMessage[0];
    const res = await new Promise((resolve) => {
      const keep = listener(clone(msg), { tab: this.tabInfo(tab) }, (r) => resolve(clone(r)));
      if (keep !== true) resolve(undefined);
    });
    await this.hop();
    return res;
  }

  // ---- background -------------------------------------------------------------

  startBackground() {
    const gen = ++this.bgGen;
    const live = (f) => (...a) => { if (gen === this.bgGen) return f(...a); };
    const L = (this.bgListeners = { onMessage: [], onRemoved: [], onUpdated: [], onCommand: [] });
    const area = (k) => ({
      get: async (key) => (key in this.storage[k] ? { [key]: clone(this.storage[k][key]) } : {}),
      set: async (o) => { Object.assign(this.storage[k], clone(o)); },
      remove: async (key) => { delete this.storage[k][key]; },
    });
    const w = this;
    const api = {
      storage: { session: area('session'), local: area('local') },
      runtime: { onMessage: { addListener: (f) => L.onMessage.push(f) } },
      tabs: {
        get: async (id) => {
          const t = w.tabs.get(id);
          if (!t) throw new Error('No tab with id: ' + id);
          return w.tabInfo(t);
        },
        query: async (q = {}) => [...w.tabs.values()]
          .filter((t) => (!q.windowId || t.windowId === q.windowId) && (!q.active || t === w.activeTab))
          .map((t) => w.tabInfo(t)),
        sendMessage: (id, msg) => w.deliverToTab(id, msg),
        onRemoved: { addListener: (f) => L.onRemoved.push(f) },
        onUpdated: { addListener: (f) => L.onUpdated.push(f) },
      },
      windows: {
        create: (o) => w.createWindow(o),
        get: async (id) => {
          const win = w.windows.get(id);
          if (!win) throw new Error('No window with id: ' + id);
          return w.winInfo(win);
        },
        update: (id, o) => w.updateWindow(id, o),
        remove: (id) => w.removeWindow(id),
      },
      commands: { onCommand: { addListener: (f) => L.onCommand.push(f) } },
      scripting: this.o.scripting
        ? { executeScript: async ({ target, files, world: where }) => {
            const page = w.tabs.get(target.tabId)?.page;
            if (!page) throw new Error('No tab');
            if (where === 'MAIN' && files.includes('content/page-bridge.js')) page.loadBridge();
            return [];
          } }
        : undefined,
    };
    const ctx = vm.createContext({
      browser: api, console, URL, structuredClone, navigator: { userAgent: 'harness' },
      setTimeout: (f, ms) => setTimeout(live(f), ms), clearTimeout,
      setInterval: (f, ms) => setInterval(live(f), ms), clearInterval,
    });
    vm.runInContext(SRC.background, ctx, { filename: 'background.js' });
    this.bg = ctx;
  }

  // Safari unloads the non-persistent background page: in-memory state and
  // pending timers are gone; storage survives.
  restartBackground() {
    this.startBackground();
  }

  bgEval(code) {
    return vm.runInContext(code, this.bg);
  }

  session() {
    return this.storage.session.session ?? null;
  }

  fireBg(name, ...args) {
    for (const f of this.bgListeners[name]) Promise.resolve(f(...args)).catch((e) => this.errors.push(name + ': ' + e.stack));
  }

  // ---- windows & tabs -----------------------------------------------------------

  screenAt(win) {
    if (win.transitionUntil && Date.now() < win.transitionUntil) return SCREENS.mac;
    if (this.tvConnected && win.left >= SCREENS.tv.x) return SCREENS.tv;
    return SCREENS.mac;
  }

  // Enter or leave native fullscreen, with the brief wrong-screen moment and
  // resize events on either side of it.
  setFullscreen(win, on) {
    if ((win.state === 'fullscreen') === on) return;
    win.state = on ? 'fullscreen' : 'normal';
    if (this.o.fsGlitchMs) {
      win.transitionUntil = Date.now() + this.o.fsGlitchMs;
      this.resized(win);
      setTimeout(() => this.resized(win), this.o.fsGlitchMs + 5);
    } else {
      this.resized(win);
    }
  }

  tabInfo(t) {
    return { id: t.id, windowId: t.windowId, url: t.url, active: t === this.activeTab };
  }

  winInfo(win) {
    return { id: win.id, left: win.left, top: win.top, width: win.width, height: win.height, state: win.state, type: win.type, focused: this.focused === win.id, tabs: win.tabs.map((id) => this.tabInfo(this.tabs.get(id))) };
  }

  newWindow(bounds, type = 'normal') {
    const win = { id: ++this.ids.win, state: 'normal', type, tabs: [], createdAt: Date.now(), ...bounds };
    this.windows.set(win.id, win);
    return win;
  }

  newTab(win, url) {
    const t = { id: ++this.ids.tab, windowId: win.id, url, page: null };
    this.tabs.set(t.id, t);
    win.tabs.push(t.id);
    return t;
  }

  // The user's own YouTube tab on the Mac.
  async openController(videoId = 'vidAlpha001') {
    const win = this.newWindow({ left: 0, top: SCREENS.mac.menu, width: 1400, height: 900 });
    const tab = this.newTab(win, 'https://www.youtube.com/watch?v=' + videoId);
    this.activeTab = tab;
    this.focused = win.id;
    tab.page = new Page(this, tab, tab.url);
    await sleep(400);
    return tab.page;
  }

  async createWindow(o) {
    await this.hop();
    if (o.type === 'popup' && !this.o.popupType) throw new Error('Invalid window type: popup');
    const bounds = { left: o.left ?? 100, top: o.top ?? 100, width: o.width ?? 1200, height: o.height ?? 800 };
    if (this.o.misplace) Object.assign(bounds, { left: 120, top: 120 });
    if (!this.tvConnected && bounds.left >= SCREENS.tv.x) Object.assign(bounds, { left: 140, top: 140 });
    const win = this.newWindow(bounds, o.type || 'normal');
    const tab = this.newTab(win, this.o.aboutBlank ? 'about:blank' : o.url);
    if (o.focused !== false) this.focused = win.id;
    if (this.o.aboutBlank) setTimeout(() => this.fireBg('onUpdated', tab.id, { url: 'about:blank', status: 'loading' }), 0);
    const [lo, hi] = this.o.loadDelay;
    setTimeout(() => {
      if (!this.tabs.has(tab.id)) return;
      tab.url = o.url;
      this.fireBg('onUpdated', tab.id, { url: o.url, status: 'loading' });
      tab.page = new Page(this, tab, o.url);
    }, lo + Math.floor(this.rand() * (hi - lo + 1)));
    return this.winInfo(win);
  }

  async updateWindow(id, o) {
    await this.hop();
    const win = this.windows.get(id);
    if (!win) throw new Error('No window with id: ' + id);
    if (o.focused) { this.focused = id; this.focusLog.push(id); }
    for (const k of ['left', 'top', 'width', 'height']) if (o[k] != null && win.state !== 'fullscreen') win[k] = o[k];
    if (!this.tvConnected && win.left >= SCREENS.tv.x) Object.assign(win, { left: 140, top: 140 });
    if (o.state === 'fullscreen') {
      const page = this.tabs.get(win.tabs[0])?.page;
      const early = !page || Date.now() - page.loadedAt < 1500;
      const honoured = this.o.fullscreen === 'works' || (this.o.fullscreen === 'afterLoad' && !early);
      if (honoured) this.setFullscreen(win, !(this.o.fsToggles && win.state === 'fullscreen'));
    } else if (o.state === 'normal') {
      this.setFullscreen(win, false);
    }
    this.resized(win);
    return this.winInfo(win);
  }

  async removeWindow(id) {
    await this.hop();
    const win = this.windows.get(id);
    if (!win) throw new Error('No window with id: ' + id);
    this.windows.delete(id);
    for (const tid of win.tabs) {
      this.tabs.get(tid)?.page?.close();
      this.tabs.delete(tid);
      this.fireBg('onRemoved', tid, { windowId: id });
    }
  }

  resized(win) {
    for (const tid of win.tabs) this.tabs.get(tid)?.page?.fire('resize');
  }

  // ---- things the user (or macOS) does --------------------------------------------

  closeTab(tabId) {
    const t = this.tabs.get(tabId);
    const win = this.windows.get(t.windowId);
    t.page?.close();
    this.tabs.delete(tabId);
    win.tabs = win.tabs.filter((id) => id !== tabId);
    if (!win.tabs.length) this.windows.delete(win.id);
    this.fireBg('onRemoved', tabId, { windowId: win.id });
  }

  // Full page load in a tab (reload, address bar, location.replace).
  navigateTab(tabId, url) {
    const t = this.tabs.get(tabId);
    if (!t) return;
    t.page?.close();
    t.page = null;
    t.url = url;
    this.fireBg('onUpdated', tabId, { url, status: 'loading' });
    setTimeout(() => {
      if (this.tabs.get(tabId) === t && !t.page) t.page = new Page(this, t, url);
    }, 120);
  }

  // ⌃⌘F / Esc on the TV.
  userExitFullscreen(winId) {
    this.setFullscreen(this.windows.get(winId), false);
  }

  // The Apple TV sleeps or AirPlay drops: macOS moves its windows to the Mac.
  disconnectTv() {
    this.tvConnected = false;
    for (const win of this.windows.values()) {
      if (win.left >= SCREENS.tv.x) Object.assign(win, { left: 160, top: 160 });
      this.resized(win);
    }
  }

  playerWindows() {
    return [...this.windows.values()].filter((w) => w.tabs.some((id) => this.tabs.get(id)?.url?.includes('ytpm-player') || this.tabs.get(id)?.wasPlayer));
  }

  playerPage() {
    const s = this.session();
    return s ? this.tabs.get(s.playerTabId)?.page ?? null : null;
  }
}

// ---------------------------------------------------------------------------
// A simulated YouTube page with the extension's content scripts injected.

let pageCount = 0;
const PAGE_HTML = (title) => `<!doctype html><html><head><title>${title} - YouTube</title></head><body>
<div id="masthead-container"><input id="search" type="text"></div>
<div id="player-container"><div id="movie_player" class="html5-video-player">
<div class="html5-video-container"><video class="video-stream html5-main-video"></video></div>
<div class="ytp-chrome-bottom"><div class="ytp-chrome-controls">
<button class="ytp-play-button ytp-button" data-title-no-tooltip="Play" aria-label="Play (k)"></button>
<div class="ytp-right-controls"><div class="ytp-right-controls-left"><button class="ytp-subtitles-button ytp-button" aria-pressed="false"></button></div>
<div class="ytp-right-controls-right"><button class="ytp-fullscreen-button ytp-button"></button></div></div>
</div></div></div></div>
<ytd-watch-metadata><h1>${title}</h1></ytd-watch-metadata>
<div id="comments"><div id="contenteditable-root" contenteditable="true"></div></div>
</body></html>`;

class Page {
  constructor(world, tab, url) {
    this.world = world;
    this.tab = tab;
    this.url = url;
    this.isPlayerUrl = url.includes('ytpm-player');
    if (this.isPlayerUrl) tab.wasPlayer = true;
    this.loadedAt = Date.now();
    this.listener = null;
    this.gestureUntil = 0;
    this.closed = false;
    this.timers = [];
    this.autoplayNext = true;

    const vc = new VirtualConsole();
    this.name = 'page' + ++pageCount;
    vc.on('jsdomError', (e) => {
      if (this.closed || /Not implemented/.test(e.message)) return;
      world.errors.push(`page ${tab.id}: ${e.message} ${e.detail?.stack || ''}`);
    });
    const id = videoIdOf(url);
    const meta = CATALOG[id] || { title: 'Unknown', d: 100 };
    this.dom = new JSDOM(PAGE_HTML(meta.title), { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
    const w = (this.win = this.dom.window);
    this.doc = w.document;
    Object.defineProperty(w.HTMLElement.prototype, 'isContentEditable', {
      configurable: true, get() { return !!this.closest('[contenteditable="true"]'); },
    });
    this.installScreen();
    this.installFullscreenApi();
    this.yt = this.installYouTube(this.doc.getElementById('movie_player'), { id, autoplay: true });
    if (url.includes('/shorts/')) this.addShortsPlayer(id);

    w.browser = {
      runtime: {
        sendMessage: (m) => world.deliverToBg(tab, JSON.parse(JSON.stringify(m))),
        onMessage: { addListener: (f) => { this.listener = f; } },
        getURL: (p) => 'safari-web-extension://ytpm/' + p,
      },
    };
    this.vmContext = this.dom.getInternalVMContext();
    if (world.o.bridge) this.loadBridge();
    vm.runInContext(SRC.content, this.vmContext, { filename: this.name + '.js' });
    // Full navigations from the content scripts go through the simulated browser.
    if (w.YTPM) w.YTPM.navigate = (u) => world.navigateTab(tab.id, u);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.world.closedPages.add(this.name);
    this.listener = null;
    this.timers.forEach(clearInterval);
    try { this.win.close(); } catch {}
  }

  every(ms, f) {
    const t = setInterval(() => { if (!this.closed) f(); }, ms);
    this.timers.push(t);
  }

  receive(msg) {
    return new Promise((resolve) => {
      const keep = this.listener(msg, { id: 'ext' }, resolve);
      if (keep !== true) resolve(undefined);
    });
  }

  fire(type) {
    if (!this.closed) this.win.dispatchEvent(new this.win.Event(type));
  }

  // ---- window geometry follows the simulated window/screen ----
  installScreen() {
    const w = this.win;
    const win = () => this.world.windows.get(this.tab.windowId);
    const scr = () => this.world.screenAt(win() || { left: 0 });
    const full = () => win()?.state === 'fullscreen' || !!this.fsEl;
    const def = (obj, k, get) => Object.defineProperty(obj, k, { configurable: true, get });
    def(w, 'screenX', () => (full() ? scr().x : win()?.left ?? 0));
    def(w, 'screenY', () => (full() ? scr().y : win()?.top ?? 0));
    def(w, 'innerWidth', () => (full() ? scr().w : win()?.width ?? 1200));
    def(w, 'innerHeight', () => (full() ? scr().h : (win()?.height ?? 800) - 80));
    def(w, 'outerWidth', () => w.innerWidth);
    def(w, 'outerHeight', () => w.innerHeight + (full() ? 0 : 80));
    def(w, 'devicePixelRatio', () => 2);
    def(w.screen, 'width', () => scr().w);
    def(w.screen, 'height', () => scr().h);
    def(w.screen, 'availLeft', () => scr().x);
    def(w.screen, 'availTop', () => scr().y + scr().menu);
    def(w.screen, 'availWidth', () => scr().w);
    def(w.screen, 'availHeight', () => scr().h - scr().menu);
  }

  installFullscreenApi() {
    const page = this;
    const d = this.doc;
    Object.defineProperty(d, 'fullscreenElement', { configurable: true, get: () => page.fsEl || null });
    this.win.Element.prototype.requestFullscreen = function () {
      if (Date.now() > page.gestureUntil) return Promise.reject(new page.win.DOMException('Fullscreen requires a user gesture', 'NotAllowedError'));
      page.fsEl = this;
      setTimeout(() => d.dispatchEvent(new page.win.Event('fullscreenchange')), 0);
      return Promise.resolve();
    };
    d.exitFullscreen = () => {
      page.fsEl = null;
      setTimeout(() => d.dispatchEvent(new page.win.Event('fullscreenchange')), 0);
      return Promise.resolve();
    };
  }

  // A real user click: grants transient activation for a second.
  userClick(el) {
    this.gestureUntil = Date.now() + 1000;
    el.click();
  }

  // ---- a fake YouTube player (video element + #movie_player API) ----
  installYouTube(container, { id, autoplay }) {
    const page = this;
    const w = this.win;
    const v = container.querySelector('video');
    const s = { id, paused: true, ended: false, t: 0, rate: 1, volume: 1, muted: false, cc: false, ccAvail: true, since: Date.now() };
    const meta = () => CATALOG[s.id] || { title: 'Unknown', d: 100 };
    const ev = (type) => v.dispatchEvent(new w.Event(type));
    const now = () => {
      if (s.paused) return s.t;
      const t = s.t + ((Date.now() - s.since) / 1000) * s.rate;
      return meta().live ? t : Math.min(t, meta().d);
    };
    const settle = () => { s.t = now(); s.since = Date.now(); };
    const setBtn = () => {
      const b = container.querySelector('.ytp-play-button');
      if (b) {
        b.setAttribute('data-title-no-tooltip', s.paused ? 'Play' : 'Pause');
        b.setAttribute('aria-label', s.paused ? 'Play (k)' : 'Pause (k)');
      }
    };
    const def = (k, get, set) => Object.defineProperty(v, k, { configurable: true, get, set });
    def('paused', () => s.paused);
    def('ended', () => s.ended);
    def('currentTime', now, (t) => { settle(); s.t = Math.max(0, meta().live ? t : Math.min(t, meta().d)); s.ended = false; ev('seeking'); setTimeout(() => ev('seeked'), 5); });
    def('duration', () => (meta().error ? NaN : meta().live ? Infinity : meta().d));
    def('playbackRate', () => s.rate, (r) => { settle(); s.rate = r; ev('ratechange'); });
    def('volume', () => s.volume, (x) => { s.volume = x; ev('volumechange'); });
    def('muted', () => s.muted, (m) => { s.muted = m; ev('volumechange'); });
    def('readyState', () => (meta().error ? 0 : 4));
    def('currentSrc', () => 'blob:https://www.youtube.com/' + s.id);
    v.getVideoPlaybackQuality = () => ({ droppedVideoFrames: 0, totalVideoFrames: Math.floor(now() * 30) });
    v.play = async () => {
      if (meta().error) throw new w.DOMException('No source', 'NotSupportedError');
      const allowed = s.muted || page.world.o.autoplay || page.unlocked || Date.now() < page.gestureUntil;
      if (!allowed) throw new w.DOMException('play() requires a user gesture', 'NotAllowedError');
      if (Date.now() < page.gestureUntil) page.unlocked = true;
      if (s.ended) { s.t = 0; s.ended = false; }
      if (!s.paused) return;
      settle();
      s.paused = false;
      setBtn();
      ev('play');
      ev('playing');
    };
    v.pause = () => {
      if (s.paused) return;
      settle();
      s.paused = true;
      setBtn();
      ev('pause');
    };
    page.every(100, () => {
      if (!s.paused && !meta().live && now() >= meta().d) {
        settle();
        s.paused = true;
        s.ended = true;
        setBtn();
        ev('pause');
        ev('ended');
        if (container.id === 'movie_player' && page.autoplayNext && NEXT[s.id]) setTimeout(() => page.spaNavigate('/watch?v=' + NEXT[s.id]), 200);
      }
      if (!s.paused) ev('timeupdate');
    });
    const load = (newId, t = 0, play = true) => {
      ev('emptied');
      Object.assign(s, { id: newId, t, paused: true, ended: false, since: Date.now() });
      setBtn();
      ev('loadstart');
      ev('loadedmetadata');
      if (play) v.play().catch(() => {});
    };
    // Main-world player API (YouTube's #movie_player methods).
    Object.assign(container, {
      getPlayerState: () => (meta().error ? -1 : s.ended ? 0 : s.paused ? 2 : 1),
      playVideo: () => { v.play().catch(() => {}); },
      pauseVideo: () => v.pause(),
      seekTo: (t) => { v.currentTime = t; },
      getCurrentTime: now,
      getDuration: () => (meta().live ? 121601512 : meta().d ?? 0),
      getPlaybackRate: () => s.rate,
      setPlaybackRate: (r) => { v.playbackRate = r; },
      getAvailablePlaybackRates: () => [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
      getVolume: () => Math.round(s.volume * 100),
      setVolume: (x) => { v.volume = x / 100; },
      isMuted: () => s.muted,
      mute: () => { v.muted = true; },
      unMute: () => { v.muted = false; },
      isSubtitlesOn: () => s.cc,
      toggleSubtitles: () => { s.cc = !s.cc; container.querySelector('.ytp-subtitles-button')?.setAttribute('aria-pressed', String(s.cc)); },
      getVideoData: () => ({ title: meta().title, video_id: s.id, isLive: !!meta().live, errorCode: meta().error || null }),
      getPlaylistId: () => null,
      loadVideoById: (o) => load(typeof o === 'string' ? o : o.videoId, (o && o.startSeconds) || 0),
      nextVideo: () => page.spaNavigate('/watch?v=' + (NEXT[s.id] || 'vidAlpha001')),
    });
    const ccBtn = container.querySelector('.ytp-subtitles-button');
    ccBtn?.addEventListener('click', () => container.toggleSubtitles());
    container.querySelector('.ytp-play-button')?.addEventListener('click', () => (s.paused ? container.playVideo() : container.pauseVideo()));
    // YouTube autoplays on load.
    setTimeout(() => {
      if (page.closed) return;
      const want = new URL(page.win.location.href).searchParams.get('t');
      if (want) s.t = parseInt(want, 10) || 0;
      ev('loadedmetadata');
      if (autoplay) v.play().catch(() => {});
    }, 30);
    return { v, s, load, meta, now };
  }

  addShortsPlayer(id) {
    const host = this.doc.createElement('div');
    host.id = 'shorts-player';
    host.className = 'html5-video-player';
    host.innerHTML = '<div class="html5-video-container"><video class="video-stream html5-main-video"></video></div>';
    this.doc.body.append(host);
    this.shorts = this.installYouTube(host, { id, autoplay: true });
  }

  // YouTube's in-page (SPA) navigation.
  spaNavigate(path) {
    if (this.closed) return;
    this.win.history.pushState({}, '', path);
    const url = this.win.location.href;
    const id = videoIdOf(url);
    if (path.startsWith('/shorts/')) {
      if (!this.shorts) this.addShortsPlayer(id);
      else this.shorts.load(id);
      this.yt.v.pause();
    } else if (id) {
      this.doc.querySelector('ytd-watch-metadata h1').textContent = CATALOG[id]?.title ?? 'Unknown';
      this.doc.title = (CATALOG[id]?.title ?? 'Unknown') + ' - YouTube';
      const t = new URL(url).searchParams.get('t');
      this.yt.load(id, t ? parseInt(t, 10) : 0);
    }
    this.doc.dispatchEvent(new this.win.Event('yt-navigate-finish'));
  }

  // YouTube seeking in place: a timestamp or chapter link in the description.
  clickTimestamp(t) {
    this.yt.v.currentTime = t;
  }

  // ---- helpers for the controller tab ----
  key(key, extra = {}, target) {
    const el = target || this.doc.body;
    for (const type of ['keydown', 'keyup']) {
      el.dispatchEvent(new this.win.KeyboardEvent(type, { key, bubbles: true, cancelable: true, composed: true, ...extra }));
    }
  }

  presenterButton() {
    return this.doc.getElementById('ytpm-btn');
  }

  barRoot() {
    return this.doc.getElementById('ytpm-remote-host')?.shadowRoot ?? null;
  }

  barButton(titlePrefix) {
    return [...(this.barRoot()?.querySelectorAll('button') || [])].find((b) => (b.getAttribute('title') || '').startsWith(titlePrefix));
  }

  bar() {
    const r = this.barRoot();
    if (!r) return null;
    const playPath = r.querySelector('.row button path')?.getAttribute('d');
    return {
      title: r.querySelector('.title')?.textContent,
      time: r.querySelector('.time')?.textContent,
      showsPaused: playPath === 'M8 5v14l11-7z', // play icon = paused
      warn: r.querySelector('.warn.show') ? r.querySelector('.warn span')?.textContent : null,
      status: r.querySelector('.status')?.textContent,
      scrubDisabled: r.querySelector('.scrub')?.disabled ?? null,
    };
  }

  toast() {
    const t = this.doc.getElementById('ytpm-toast-host')?.shadowRoot?.querySelector('.t');
    return t && !t.classList.contains('hide') ? t.textContent : null;
  }

  // ---- helpers for the player window ----
  overlayKind() {
    const host = this.doc.getElementById('ytpm-overlay-host');
    if (!host) return null;
    const text = host.shadowRoot.textContent;
    if (/Drag this window/i.test(text)) return 'placement';
    if (/fullscreen/i.test(text)) return 'fullscreen';
    if (/Click to start/i.test(text)) return 'gesture';
    if (/Drag this window/i.test(text)) return 'placement';
    if (/Apple TV|AirPlay/i.test(text)) return 'airplay';
    return 'other';
  }

  clickOverlay() {
    const b = this.doc.getElementById('ytpm-overlay-host')?.shadowRoot?.querySelector('.backdrop');
    if (b) this.userClick(b);
    return !!b;
  }

  loadBridge() {
    if (!this.closed) vm.runInContext(SRC.bridge, this.vmContext, { filename: this.name + '-bridge.js' });
  }
}

// Wait until a condition holds (or fail with a description).
export async function until(cond, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    let ok = false;
    try { ok = await cond(); } catch {}
    if (ok) return;
    if (Date.now() > end) throw new Error('timed out waiting for: ' + what);
    await sleep(25);
  }
}
