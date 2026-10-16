// Controller role: the original tab on the Mac. Its own video stays paused
// and muted; the remote bar and the usual shortcuts drive the player. Site
// specifics come from YTPM.site.
'use strict';
YTPM.Controller = (() => {
  const { h, icon, fmtTime } = YTPM;
  const site = () => YTPM.site;
  const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  let enabled = true;
  let active = false;
  let session = null;
  let st = null; // last player state
  let stAt = 0; // when it arrived
  let awaitCmd = null; // {id, at}: optimistic command the player hasn't confirmed yet
  let pendingToggle = false; // play/pause pressed before the first state report
  let cmdSeq = 0;
  let starting = false;
  let startedHere = false; // this tab started the session (vs. picked it up after a reload)
  let enteredAt = 0;
  let lastNavAt = 0;
  let lastHref = location.href;
  let lastLoad = { id: null, at: 0 };
  const endedSessions = new Set();
  let prevMuted = null;
  let scrubbing = false;
  let volDragging = false;
  let ui = null;
  let tick = null;
  let toastHost = null;
  let toastTimer = null;

  const ENDED_MESSAGES = {
    user: 'Presenter mode ended.',
    shortcut: 'Presenter mode ended.',
    popup: 'Presenter mode ended.',
    'player-closed': 'The TV window was closed. Presenter mode ended.',
    replaced: 'Presenter mode moved to another tab.',
    unreachable: "Couldn't reach the TV window. If it's still open, close it yourself.",
    'controller-reloaded': 'The TV video stopped when this page reloaded (in move mode the page plays it). Start again.',
    'move-reset': "Safari restarted the video when moving it to the TV, so move mode can't work on this site. Turn it off in the toolbar popup.",
  };
  // Holding these keys keeps acting; everything else fires once per press.
  const REPEATABLE = new Set(['seekBy', 'volumeBy']);

  const NEEDS_CLICK = {
    gesture: 'TV window needs a click to start playback.',
    fullscreen: 'TV window needs a click to go fullscreen.',
    airplay: 'Pick your Apple TV: click the player window.',
    placement: 'Drag the player window onto the TV.',
  };

  // ---- keyboard forwarding -------------------------------------------------------
  // YouTube's keys (Twitch uses the same few); looked up by KeyboardEvent.key.
  const KEYMAP = {
    ' ': ['togglePlay'], k: ['togglePlay'],
    j: ['seekBy', -10], l: ['seekBy', 10],
    ArrowLeft: ['seekBy', -5], ArrowRight: ['seekBy', 5],
    ArrowUp: ['volumeBy', 5], ArrowDown: ['volumeBy', -5],
    m: ['toggleMute'], c: ['toggleCaptions'], f: ['toggleFullscreen'],
    '<': ['rateStep', -1], '>': ['rateStep', 1],
    N: ['next'],
  };

  function mapKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return null;
    if (/^[0-9]$/.test(e.key)) return ['seekPercent', Number(e.key)];
    if (e.key === '<' || e.key === '>' || (e.key === 'N' && e.shiftKey)) return KEYMAP[e.key];
    if (e.shiftKey) return null;
    return KEYMAP[e.key.length === 1 ? e.key.toLowerCase() : e.key] || null;
  }

  function isEditable(e) {
    const el = e.composedPath?.()[0] || e.target;
    if (!(el instanceof Element)) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    if (el.tagName === 'INPUT') return !['range', 'button', 'checkbox', 'radio'].includes(el.type);
    return false;
  }

  // Registered at document_start in the capture phase on window, so this runs
  // before any of the site's own key handlers.
  function onKeyDown(e) {
    if (!active || e.isComposing || isEditable(e)) return;
    const m = mapKey(e);
    if (!m) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat && !REPEATABLE.has(m[0])) return;
    command(m[0], m[1]);
  }

  function swallowKey(e) {
    if (active && !e.isComposing && !isEditable(e) && mapKey(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  // ---- local video ----------------------------------------------------------------

  const isMainVideo = (el) => el instanceof HTMLMediaElement && !!site().isMainVideo(el);
  const isPlayerVideo = (el) => el instanceof HTMLMediaElement && !!site().isPlayerVideo(el);

  function holdLocal(v) {
    if (!v.muted) v.muted = true;
    if (!v.paused) v.pause();
  }

  function holdAllLocal() {
    // In move mode the main video is the one on the TV.
    site().localVideos().forEach((v) => { if (!YTPM.Move.owns(v)) holdLocal(v); });
  }

  function installGuards() {
    YTPM.Move.setHooks({ command, toast, ended: (reason) => exit(st, reason) });
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', swallowKey, true);
    window.addEventListener('keypress', swallowKey, true);
    // Media events don't bubble, but capture-phase listeners on document still see them.
    // While presenting, nothing on this page plays with sound.
    document.addEventListener('play', (e) => {
      if (active && (isPlayerVideo(e.target) || (e.target instanceof HTMLMediaElement && !e.target.muted))) holdLocal(e.target);
    }, true);
    document.addEventListener('volumechange', (e) => {
      if (active && isPlayerVideo(e.target) && !e.target.muted) e.target.muted = true;
    }, true);
    document.addEventListener('seeked', onLocalSeek, true);
    // YouTube announces its in-page navigations; other sites are polled.
    document.addEventListener('yt-navigate-finish', () => { lastHref = location.href; onNavigate(); });
    setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      onNavigate();
    }, 500);
    setInterval(() => {
      ensureButton();
      if (active) {
        attachShield();
        holdAllLocal();
      }
    }, 1000);
  }

  // A timestamp or chapter link (or the site's own scrubber) seeks the paused
  // local player in place. Pass that on to the TV, but not the seeks a site
  // makes by itself while a page loads.
  function onLocalSeek(e) {
    if (!active || !isMainVideo(e.target)) return;
    if (Date.now() - Math.max(lastNavAt, enteredAt) < 1500) return;
    const here = site().parse(location.href)?.key;
    if (!here || here !== st?.key || st?.live) return;
    if (Math.abs(e.target.currentTime - currentTime()) < 1.5) return;
    command('seekTo', e.target.currentTime);
  }

  function setEnabled(v) {
    enabled = v;
    if (!v) document.getElementById('ytpm-btn')?.remove();
  }

  function init(hello) {
    if (hello?.role !== 'controller' || !hello.session) return;
    enter(hello.session);
    // Move mode: this page reloaded; the video on the TV was this page's.
    if (hello.session.move) YTPM.Move.resume(hello.session);
  }

  // ---- presenter button in the site's player controls ------------------------------

  function ensureButton() {
    if (!enabled || !site().parse(location.href)) return;
    let btn = document.getElementById('ytpm-btn');
    if (!btn) {
      btn = h('button', {
        id: 'ytpm-btn',
        title: 'Presenter mode: play on TV (⌥⇧P)',
        'aria-label': 'Presenter mode',
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          toggle();
        },
      }, icon('present', 24));
      if (!site().insertButton(btn)) return;
    }
    btn.style.color = active ? '#3ea6ff' : '#fff';
  }

  // Covers the paused local player so clicks on it go to the TV instead.
  function attachShield() {
    if (!active || site().parse(location.href)?.key !== session?.key) return;
    const host = site().shieldHost();
    if (!host || host.querySelector(':scope > #ytpm-shield')) return;
    const stop = (e) => e.stopPropagation();
    const airplay = session?.mode === 'airplay';
    host.append(h('div', {
      id: 'ytpm-shield',
      style: 'position:absolute;inset:0;z-index:1000;display:flex;flex-direction:column;align-items:center;' +
        'justify-content:center;gap:8px;background:rgba(0,0,0,.8);color:#fff;cursor:pointer;text-align:center;' +
        'padding:16px;font:600 18px/1.3 -apple-system,BlinkMacSystemFont,Roboto,sans-serif;',
      onclick: (e) => { stop(e); command('togglePlay'); },
      onmousedown: stop, onmouseup: stop, ondblclick: stop, onpointerdown: stop, onpointerup: stop,
    },
    icon(airplay ? 'airplay' : 'tv', 56),
    h('div', {}, airplay ? 'Playing on Apple TV' : 'Playing on your TV'),
    h('div', { style: 'font-weight:400;font-size:13px;color:#bbb' },
      'Click to play/pause. Keyboard shortcuts control the TV.')));
  }

  // ---- session ---------------------------------------------------------------------

  function toggle() {
    // A slow double-click on the presenter button shouldn't start and then end.
    if (active && Date.now() - enteredAt < 1000) return;
    return active ? end() : start();
  }

  async function start() {
    if (starting) return; // double-click
    const item = site().parse(location.href);
    if (!item) return toast('Open a video first.');
    const v = site().findVideo();
    if (!v) return toast('No video found on this page.');
    if (site().canMove) {
      starting = true;
      let move = false;
      try {
        move = await YTPM.Move.wanted();
        if (move) await startMoved(item, v);
      } finally {
        starting = false;
      }
      if (move) return;
    }
    const live = !Number.isFinite(v.duration);
    const t = live ? 0 : v.currentTime;
    starting = true;
    try {
      toast('Opening the player window…');
      // Safe to retry: the background returns the session it just started.
      const res = await YTPM.sendRetry({
        type: 'start',
        site: site().id,
        key: item.key,
        url: site().playerUrl(item, t),
        t,
        d: live ? null : v.duration,
        screen: YTPM.screenInfo(),
      });
      if (!res?.ok) return toast('Could not open the player window: ' + (res?.error || 'no response from the extension'));
      if (endedSessions.has(res.session.id)) return; // ended while we waited
      startedHere = true;
      enter(res.session);
    } finally {
      starting = false;
    }
  }

  // Move mode (experimental): instead of opening the page's address on the
  // TV, open a window from this page and move this page's own video into it.
  async function startMoved(item, v) {
    const live = !Number.isFinite(v.duration);
    const res = await YTPM.Move.begin(v, (extra) => {
      toast('Opening the TV window…');
      const t = live ? 0 : v.currentTime;
      return YTPM.sendRetry({
        type: 'start', site: site().id, key: item.key, url: location.href,
        t, d: live ? null : v.duration, screen: YTPM.screenInfo(), ...extra,
      });
    });
    if (!res) return;
    if (!res.ok) return toast('Could not start presenter mode: ' + (res.error || 'no response from the extension'));
    if (endedSessions.has(res.session.id)) return void YTPM.Move.stop();
    startedHere = true;
    enter(res.session);
    YTPM.Move.start(res.session);
  }

  async function end() {
    // Move mode: put the video back in the page before its window closes.
    const tv = session?.move ? YTPM.Move.stop({ closeTv: false }) : null;
    const res = await YTPM.sendRetry({ type: 'end', reason: 'user' });
    if (!res) try { tv?.close(); } catch {}
    exit(res?.final ?? st, res ? 'user' : 'unreachable');
  }

  function enter(s) {
    if (active && session?.id === s.id) return;
    session = s;
    if (!active) {
      const v = site().findVideo();
      prevMuted = v ? v.muted : null;
      enteredAt = Date.now();
      if (!starting) startedHere = false;
      st = null;
      awaitCmd = null;
    }
    active = true;
    holdAllLocal();
    buildUI();
    attachShield();
    ensureButton();
    clearInterval(tick);
    tick = setInterval(render, 250);
    render();
  }

  function exit(final, reason) {
    if (session?.id) endedSessions.add(session.id);
    if (!active) return;
    active = false;
    pendingToggle = false;
    clearInterval(tick);
    ui?.host.remove();
    ui = null;
    document.getElementById('ytpm-shield')?.remove();
    const v = site().findVideo();
    // Move mode puts its video back (paused) itself.
    if (session?.move) YTPM.Move.stop();
    else if (v) {
      v.muted = prevMuted ?? false;
      // Leave the Mac paused at the point the TV reached.
      const here = site().parse(location.href)?.key;
      if (final && !final.live && final.key === here && Number.isFinite(final.t)) v.currentTime = final.t;
    }
    session = null;
    st = null;
    ensureButton();
    toast(ENDED_MESSAGES[reason] || 'Presenter mode ended.');
  }

  function onNavigate() {
    ensureButton();
    lastNavAt = Date.now();
    if (!active) return;
    holdAllLocal();
    // Picking another video here (on YouTube a watch page, Short or live
    // link; on Twitch a channel, VOD or clip) plays it on the TV instead.
    // A navigation can be reported twice (event and polling).
    const item = site().followsNavigation ? site().parse(location.href) : null;
    const repeat = item && lastLoad.id === item.key && Date.now() - lastLoad.at < 2000;
    if (item && item.key !== st?.key && !repeat) {
      lastLoad = { id: item.key, at: Date.now() };
      command('load', { key: item.key, url: site().playerUrl(item, item.t || 0), t: item.t || 0, list: item.list, index: item.index });
      toast('Sent to the TV.');
    }
    attachShield();
  }

  function command(action, value) {
    // Send an explicit play or pause matching what the bar shows. A toggle can
    // undo itself when a state report crosses it in flight.
    if (action === 'togglePlay') {
      if (st) action = st.paused || st.ended ? 'play' : 'pause';
      // No report yet. A TV that was just started is about to play, so the
      // press means pause; otherwise decide when the first report arrives.
      else if (startedHere && Date.now() - enteredAt < 8000) action = 'pause';
      else {
        pendingToggle = true;
        return;
      }
    }
    if (st?.live && (action === 'seekPercent' || action === 'rateStep' || action === 'setRate')) return;
    if (action === 'next' && st && !st.hasNext) return;
    // Time-based sequence numbers stay increasing across reloads of this tab.
    const seq = Date.now() * 1000 + (++cmdSeq % 1000);
    const id = 'c' + seq.toString(36);
    // Optimistic updates so the bar feels immediate. Reports that don't yet
    // include this command are held back until the player confirms it.
    if (st) {
      const now = Date.now();
      const t = currentTime();
      let changed = true;
      if (action === 'play' || action === 'pause') st = { ...st, t, paused: action === 'pause', ended: false };
      else if (action === 'seekBy') st = { ...st, t: Math.max(0, t + value) };
      else if (action === 'seekTo') st = { ...st, t: value };
      else changed = false;
      if (changed) {
        stAt = now;
        awaitCmd = { id, at: now };
      }
    }
    render();
    YTPM.sendRetry({ type: 'cmd', id, seq, action, value }).then((r) => {
      if (!active) return;
      if (!r) toast("Couldn't reach the extension. Try again.");
      else if (r.ok === false) toast('TV did not respond: ' + (r.error || action));
    });
  }

  function currentTime() {
    if (!st) return 0;
    const age = Date.now() - stAt;
    const playing = !st.paused && !st.ended;
    const t = st.t + (playing && age < 5000 ? (age / 1000) * (st.rate || 1) : 0);
    return st.d ? Math.min(st.d, t) : t;
  }

  // ---- remote bar -----------------------------------------------------------------

  const BAR_CSS = `
:host { all: initial; }
.bar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 2147483646;
  width: min(1000px, calc(100vw - 32px)); box-sizing: border-box; padding: 10px 12px 10px 16px;
  background: rgba(20,20,20,.95); color: #f1f1f1; border-radius: 14px;
  box-shadow: 0 12px 32px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.08);
  font: 13px/1.3 -apple-system, BlinkMacSystemFont, "Roboto", "Helvetica Neue", sans-serif;
  -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); }
.top { display: flex; align-items: center; gap: 10px; min-height: 32px; }
.status { display: inline-flex; align-items: center; gap: 6px; flex: none; font-size: 11px; font-weight: 600;
  letter-spacing: .06em; text-transform: uppercase; color: #aaa; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #888; }
.dot.live { background: #2ecc71; } .dot.stale { background: #f1c40f; } .dot.lost { background: #e74c3c; }
.title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  font-size: 14px; font-weight: 600; }
.warn { display: none; align-items: center; gap: 8px; margin-top: 6px; padding: 6px 10px; border-radius: 8px;
  background: rgba(241,196,15,.12); color: #f5d76e; font-size: 12px; }
.warn.show { display: flex; }
.warn button { height: 24px; font-size: 12px; background: rgba(255,255,255,.12); }
.row { display: flex; align-items: center; gap: 4px; margin-top: 6px; }
button { all: unset; box-sizing: border-box; height: 32px; min-width: 32px; padding: 0 8px; border-radius: 8px;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px; cursor: pointer;
  color: inherit; font: inherit; font-weight: 600; white-space: nowrap; }
button:hover { background: rgba(255,255,255,.1); }
button:focus-visible, select:focus-visible { outline: 2px solid #3ea6ff; outline-offset: 1px; }
button.on { color: #3ea6ff; }
button.dim { opacity: .4; }
button.end { background: #cc0000; color: #fff; padding: 0 12px; }
button.end:hover { background: #e00000; }
.time { flex: none; min-width: 96px; text-align: center; color: #ccc; font-size: 12px;
  font-variant-numeric: tabular-nums; }
input[type=range] { -webkit-appearance: none; appearance: none; margin: 0; height: 20px; background: transparent;
  cursor: pointer; --p: 0%; }
input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px;
  background: linear-gradient(to right, var(--fill) var(--p), rgba(255,255,255,.25) var(--p)); }
input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 13px; height: 13px; margin-top: -4.5px;
  border-radius: 50%; background: var(--fill); }
.scrub { --fill: #f00; flex: 1; min-width: 80px; }
.vol { --fill: #fff; width: 72px; flex: none; }
select { -webkit-appearance: none; appearance: none; height: 28px; padding: 0 8px; border: 0; border-radius: 8px;
  background: rgba(255,255,255,.1); color: inherit; font: inherit; font-weight: 600; cursor: pointer; }
.collapsed .row, .collapsed .warn.show { display: none; }
@media (max-width: 720px) { .vol, .speed { display: none; } }
`;

  function buildUI() {
    if (ui) return;
    const host = h('div', { id: 'ytpm-remote-host' });
    const root = host.attachShadow({ mode: 'open' });
    const style = h('style');
    style.textContent = BAR_CSS;

    const btn = (label, title, onclick, cls) =>
      h('button', { title, 'aria-label': title, class: cls, onclick: (e) => { e.stopPropagation(); onclick(e); } }, label);

    const r = {};
    r.dot = h('span', { class: 'dot' });
    r.statusText = h('span', {}, 'Connecting');
    r.title = h('div', { class: 'title' }, 'Starting presenter mode…');
    r.collapse = btn(icon('collapse', 18), 'Collapse', () => {
      const c = r.bar.classList.toggle('collapsed');
      r.collapse.replaceChildren(icon(c ? 'expand' : 'collapse', 18));
    });
    r.warnText = h('span', {});
    r.warn = h('div', { class: 'warn' }, r.warnText,
      btn('Show player window', 'Bring the player window forward', () => YTPM.send({ type: 'focusPlayer' })));

    r.play = btn(icon('play'), 'Play/pause (k)', () => command('togglePlay'));
    r.back = btn('−10', 'Back 10 seconds (j)', () => command('seekBy', -10));
    r.fwd = btn('+10', 'Forward 10 seconds (l)', () => command('seekBy', 10));
    r.time = h('div', { class: 'time' }, '0:00 / 0:00');
    r.scrub = h('input', { type: 'range', class: 'scrub', min: 0, max: 1000, step: 1, value: 0, tabindex: -1, 'aria-label': 'Seek' });
    r.scrub.addEventListener('pointerdown', () => { scrubbing = true; });
    r.scrub.addEventListener('input', () => {
      scrubbing = true;
      const p = r.scrub.value / 1000;
      setFill(r.scrub, p);
      if (st?.d) r.time.textContent = fmtTime(p * st.d) + ' / ' + fmtTime(st.d);
    });
    r.scrub.addEventListener('change', () => {
      if (st?.d) command('seekTo', (r.scrub.value / 1000) * st.d);
      scrubbing = false;
    });
    r.speed = h('select', { class: 'speed', title: 'Playback speed (< >)', 'aria-label': 'Playback speed',
      onchange: () => command('setRate', Number(r.speed.value)) });
    setRateOptions(r.speed, RATES);
    r.cc = btn(icon('cc'), 'Captions (c)', () => command('toggleCaptions'));
    r.mute = btn(icon('vol'), 'Mute (m)', () => command('toggleMute'));
    r.vol = h('input', { type: 'range', class: 'vol', min: 0, max: 100, step: 1, value: 100, tabindex: -1, 'aria-label': 'Volume' });
    r.vol.addEventListener('input', () => { volDragging = true; setFill(r.vol, r.vol.value / 100); });
    r.vol.addEventListener('change', () => { command('setVolume', Number(r.vol.value)); volDragging = false; });
    r.fs = btn(icon('fullscreen'), 'Toggle fullscreen on the TV (f)', () => command('toggleFullscreen'));
    r.end = btn('End', 'End presenter mode', () => end(), 'end');

    r.bar = h('div', { class: 'bar', role: 'region', 'aria-label': 'Presenter remote' },
      h('div', { class: 'top' }, h('span', { class: 'status' }, r.dot, r.statusText), r.title, r.collapse, r.end),
      r.warn,
      h('div', { class: 'row' }, r.play, r.back, r.fwd, r.time, r.scrub, r.speed, r.cc, r.mute, r.vol, r.fs));
    root.append(style, r.bar);
    document.documentElement.append(host);
    ui = { host, ...r, playing: null, muted: null };
  }

  function setFill(input, p) {
    input.style.setProperty('--p', (Math.max(0, Math.min(1, p)) * 100).toFixed(2) + '%');
  }

  function setRateOptions(select, rates) {
    const key = rates.join(',');
    if (select.dataset.rates === key) return;
    select.dataset.rates = key;
    select.replaceChildren(...rates.map((r) => h('option', { value: String(r) }, r === 1 ? 'Normal' : r + '×')));
  }

  function render() {
    if (!ui) return;
    const modeLabel = session?.mode === 'airplay' ? 'AirPlay' : 'TV';
    if (!st) {
      ui.dot.className = 'dot';
      ui.statusText.textContent = modeLabel + ' · connecting';
      return;
    }
    const age = Date.now() - stAt;
    ui.dot.className = 'dot ' + (age < 2500 ? 'live' : age < 8000 ? 'stale' : 'lost');
    let status = modeLabel;
    if (age >= 8000) status += ' · no signal';
    else if (session?.mode === 'airplay') status += st.wireless ? ' · connected' : ' · not connected';
    ui.statusText.textContent = status;
    ui.title.textContent = st.title || 'Video';
    ui.title.title = st.title || '';

    const playing = !st.paused && !st.ended;
    if (playing !== ui.playing) {
      ui.playing = playing;
      ui.play.replaceChildren(icon(playing ? 'pause' : 'play'));
    }
    const t = currentTime();
    ui.scrub.disabled = !!st.live || !st.d;
    ui.speed.disabled = !!st.live;
    if (st.live) {
      ui.time.textContent = 'LIVE';
      ui.scrub.value = '1000';
      setFill(ui.scrub, 1);
    } else if (!scrubbing) {
      ui.time.textContent = fmtTime(t) + ' / ' + fmtTime(st.d);
      const p = st.d ? t / st.d : 0;
      ui.scrub.value = String(Math.round(p * 1000));
      setFill(ui.scrub, p);
    }
    const rates = st.rates?.length ? st.rates : RATES;
    setRateOptions(ui.speed, rates.includes(st.rate) ? rates : [...rates, st.rate].sort((a, b) => a - b));
    if (ui.speed.value !== String(st.rate)) ui.speed.value = String(st.rate);
    ui.cc.classList.toggle('on', !!st.cc);
    ui.cc.classList.toggle('dim', !st.ccAvail);
    const muted = !!st.muted || st.vol === 0;
    if (muted !== ui.muted) {
      ui.muted = muted;
      ui.mute.replaceChildren(icon(muted ? 'mute' : 'vol'));
    }
    if (!volDragging) {
      ui.vol.value = String(muted ? 0 : st.vol);
      setFill(ui.vol, muted ? 0 : st.vol / 100);
    }
    const warn = age >= 8000
      ? 'The player window stopped reporting. It may be closed, frozen or throttled.'
      : st.error
        ? `The TV can't play this video (${st.error}).`
        : st.stalled
          ? 'The TV video is stuck. In move mode this tab plays it: keep the tab open and visible.'
          : NEEDS_CLICK[st.overlay];
    ui.warn.classList.toggle('show', !!warn);
    ui.warnText.textContent = warn || '';
  }

  // ---- toast ----------------------------------------------------------------------

  function toast(text) {
    if (!toastHost) {
      toastHost = h('div', { id: 'ytpm-toast-host' });
      const root = toastHost.attachShadow({ mode: 'open' });
      const style = h('style');
      style.textContent = `:host{all:initial}.t{position:fixed;left:50%;top:72px;transform:translateX(-50%);
        z-index:2147483647;background:rgba(20,20,20,.95);color:#fff;padding:10px 16px;border-radius:10px;
        font:600 13px/1.3 -apple-system,BlinkMacSystemFont,Roboto,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4);
        transition:opacity .2s;max-width:calc(100vw - 48px)}.t.hide{opacity:0;pointer-events:none}`;
      root.append(style, h('div', { class: 't hide' }));
    }
    if (!toastHost.isConnected) document.documentElement.append(toastHost);
    const el = toastHost.shadowRoot.querySelector('.t');
    el.textContent = text;
    el.classList.remove('hide');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hide'), 3500);
  }

  // ---- messages from the background ------------------------------------------------

  function onMessage(msg) {
    switch (msg.type) {
      case 'state': {
        // A report still in flight when presenter mode ended must not revive it.
        if (msg.session?.id && endedSessions.has(msg.session.id)) return { ok: true, ignored: true };
        if (!active && msg.session) enter(msg.session);
        if (!active) return { ok: true };
        // Keep the optimistic state until the player has run the command.
        const ran = msg.state.ran || [];
        if (awaitCmd && !ran.includes(awaitCmd.id) && Date.now() - awaitCmd.at < 2500) return { ok: true };
        awaitCmd = null;
        st = msg.state;
        stAt = Date.now();
        if (pendingToggle) {
          pendingToggle = false;
          command('togglePlay');
        }
        render();
        return { ok: true };
      }
      case 'session-ended':
        if (msg.sessionId) endedSessions.add(msg.sessionId);
        exit(msg.final, msg.reason);
        return { ok: true };
      case 'start-request':
        toggle();
        return { ok: true };
      // Move mode: this tab stands in for the TV window, which has no content script.
      case 'cmd':
      case 'getState':
      case 'needFullscreenClick':
        return YTPM.Move.onMessage(msg) ?? { ok: false, error: 'not presenting from this tab' };
      case 'event':
        if (msg.name === 'airplay-disconnected') toast('AirPlay disconnected. Click the player window to reconnect.');
        if (msg.name === 'airplay-connected') toast('AirPlay connected.');
        if (msg.name === 'play-blocked') toast('Safari blocked playback in the player window. Click it once.');
        if (msg.name === 'fullscreen-needs-click') toast('Safari needs one click on the TV to go fullscreen.');
        if (msg.name === 'tv-lost') toast('TV display disconnected, so playback is paused.');
        return { ok: true };
    }
    return { ok: false, error: 'unhandled ' + msg.type };
  }

  return { installGuards, setEnabled, init, onMessage };
})();
