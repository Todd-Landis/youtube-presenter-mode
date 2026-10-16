// Move mode (experimental; generic sites only, opt-in in the toolbar popup).
// Reopening the page's address on the TV can show a different video in a
// feed (X, Reddit, Instagram). Instead, this tab opens a same-origin popup and
// moves its own <video> element into it. The site's scripts keep feeding and
// driving that element, so the stream, position and ad state carry over.
//
// The popup has no content script, so this tab also plays the player role: it
// reports the popup's screen and the video's state, and runs the remote's
// commands on the element. Playback depends on this tab: closing it ends
// presenter mode, and so does a reload unless the video is a plain file.
'use strict';
YTPM.Move = (() => {
  const { h, sleep, clamp } = YTPM;
  const site = () => YTPM.site;
  const DEFAULT_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  // Chromium reloads a media element adopted into another document (it
  // empties, then restarts or errors). Seen this soon after the move, it means
  // the browser can't keep the video playing this way.
  const RESET_WATCH_MS = 3000;
  const STUCK_MS = 3000;
  // The click that started move mode still counts as user activation for a
  // few seconds; a pause in that window isn't the user pausing.
  const ACTIVATION_GRACE_MS = 6000;

  let hooks = { command: () => {}, toast: () => {}, ended: () => {} };
  let session = null;
  let active = false;
  let pw = null; // the TV window (a popup this tab opened)
  let video = null; // the element now in it
  let home = null; // placeholder where the element came from
  let savedStyle = null;
  let filledStyle = null;
  let timers = [];
  let seq = 0;
  let movedAt = 0;
  let failed = false;
  let wantedPlay = null;
  let ourPauseUntil = 0;
  let resumes = [];
  let lastT = null;
  let stuckSince = 0;
  let needGesture = false;
  let needFullscreen = false;
  let overlay = null;
  let overlayKind = null;
  let prompt = null;

  const setHooks = (o) => { hooks = { ...hooks, ...o }; };
  const owns = (el) => !!el && el === video;
  const isActive = () => active;
  const tvOpen = () => !!pw && !pw.closed;
  const finite = (n) => (Number.isFinite(n) ? n : null);
  const tracks = (v) => [...(v?.textTracks || [])].filter((t) => t.kind === 'subtitles' || t.kind === 'captions');
  const event = (name, data, notify = false) => YTPM.send({ type: 'event', name, data: data ?? null, notify });

  // On, on a site that allows it, with the extended-display mode (AirPlay
  // video needs the player window's AirPlay handling, which this doesn't have).
  async function wanted() {
    if (!site().canMove) return false;
    try {
      const settings = (await YTPM.ext.storage.local.get('settings')).settings;
      return !!settings?.moveVideo && settings.mode !== 'airplay';
    } catch {
      return false;
    }
  }

  // Where the TV window goes: where it was last time, else right of this screen.
  async function tvBounds() {
    let b = null;
    try { b = (await YTPM.ext.storage.local.get('tvBounds')).tvBounds; } catch {}
    const s = YTPM.screenInfo();
    return b || { left: (s.al ?? 0) + s.sw, top: s.at ?? 0, width: 1280, height: 720 };
  }

  // ---- starting ------------------------------------------------------------------

  // window.open needs a click on the page. Started from the toolbar or the
  // shortcut there isn't one, so ask for it. sendStart(extra) asks the
  // background to start the session; resolves to its reply, or null.
  async function begin(v, sendStart) {
    const bounds = await tvBounds();
    return new Promise((resolve) => {
      const go = () => {
        closePrompt();
        const opened = openAndMove(v, bounds);
        if (!opened) {
          hooks.toast('Safari blocked the TV window. Try again, or allow pop-ups for this site.');
          return resolve(null);
        }
        resolve(Promise.resolve(sendStart({ move: true, moveName: opened.name, marker: opened.marker })).then((res) => {
          if (!res?.ok) stop();
          return res;
        }));
      };
      if (navigator.userActivation?.isActive) go();
      else showPrompt(go, () => resolve(null));
    });
  }

  function openAndMove(v, b) {
    failed = false;
    const id = Math.random().toString(36).slice(2, 10);
    const name = 'ytpm-tv-' + id;
    const marker = 'Presenter Mode TV ' + id; // how the background finds the window
    let w = null;
    try {
      // An empty URL keeps the popup's initial document; no load replaces it later.
      w = window.open('', name, `popup,left=${Math.round(b.left)},top=${Math.round(b.top)},width=${Math.round(b.width)},height=${Math.round(b.height)}`);
    } catch {}
    if (!w) return null;
    try {
      const d = w.document;
      d.title = marker;
      // CSSOM rather than a <style> element: the popup inherits the page's CSP.
      for (const el of [d.documentElement, d.body]) {
        el.style.setProperty('margin', '0');
        el.style.setProperty('height', '100%');
        el.style.setProperty('background', '#000');
        el.style.setProperty('overflow', 'hidden');
        el.style.setProperty('cursor', 'none');
      }
      const playing = !v.paused;
      pw = w;
      video = v;
      home = placeholder(v);
      savedStyle = v.style.cssText;
      v.before(home);
      v.setAttribute('data-ytpm-moved', id);
      // One DOM operation adopts it into the popup's document, so it never sits
      // outside a document (which would pause it).
      d.body.append(v);
      fill(v);
      movedAt = Date.now();
      if (playing && v.paused) v.play().catch(() => {});
      pw.addEventListener('pagehide', onTvClosing);
      bindVideo(v);
      return { name, marker };
    } catch (e) {
      YTPM.debug('move failed', e);
      stop();
      try { w.close(); } catch {}
      return null;
    }
  }

  // Fill the TV window. Important inline properties beat the site's own
  // inline sizes. Re-applied with each report if the site has rewritten the
  // element's style meanwhile.
  const FILL = {
    position: 'fixed', top: '0', left: '0', right: '0', bottom: '0', width: '100vw', height: '100vh',
    'max-width': 'none', 'max-height': 'none', margin: '0', padding: '0', border: '0', transform: 'none',
    'object-fit': 'contain', background: '#000', display: 'block', visibility: 'visible', opacity: '1', 'z-index': '0',
  };
  function fill(v) {
    if (filledStyle != null && v.style.cssText === filledStyle) return;
    for (const [k, val] of Object.entries(FILL)) v.style.setProperty(k, val, 'important');
    filledStyle = v.style.cssText;
  }

  // Keeps the page's layout where the video was; a click plays or pauses the TV.
  function placeholder(v) {
    const r = v.getBoundingClientRect();
    const pos = getComputedStyle(v).position;
    const el = h('div', {
      'data-ytpm-home': '',
      title: 'Playing on your TV. Click to play or pause.',
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); hooks.command('togglePlay'); },
    }, YTPM.icon('tv', 44), h('div', {}, 'Playing on your TV'));
    const size = pos === 'absolute' || pos === 'fixed'
      ? 'position:absolute;top:0;left:0;width:100%;height:100%;'
      : `width:${r.width ? r.width + 'px' : '100%'};max-width:100%;` + (r.height ? `height:${r.height}px;` : 'aspect-ratio:16/9;');
    el.style.cssText = size + 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;' +
      'box-sizing:border-box;background:#000;color:#fff;cursor:pointer;font:600 15px/1.3 -apple-system,BlinkMacSystemFont,sans-serif;';
    return el;
  }

  function showPrompt(go, cancel) {
    closePrompt();
    const host = h('div', { id: 'ytpm-move-prompt' });
    const root = host.attachShadow({ mode: 'open' });
    const style = h('style');
    style.textContent = `:host{all:initial}.p{position:fixed;left:50%;top:72px;transform:translateX(-50%);z-index:2147483647;
      display:flex;align-items:center;gap:10px;padding:10px 12px 10px 16px;border-radius:12px;background:rgba(20,20,20,.96);
      color:#fff;font:600 13px/1.3 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45);
      max-width:calc(100vw - 32px)}button{all:unset;cursor:pointer;padding:7px 12px;border-radius:8px;white-space:nowrap}
      .go{background:#0a84ff}.go:hover{background:#3a9bff}.no{color:#bbb}.no:hover{background:rgba(255,255,255,.1)}`;
    const cancelIt = () => { closePrompt(); cancel(); };
    root.append(style, h('div', { class: 'p', role: 'dialog', 'aria-label': 'Presenter mode' },
      h('span', {}, 'Move this video to the TV?'),
      h('button', { class: 'go', onclick: (e) => { e.stopPropagation(); go(); } }, 'Move to TV'),
      h('button', { class: 'no', onclick: (e) => { e.stopPropagation(); cancelIt(); } }, 'Cancel')));
    document.documentElement.append(host);
    prompt = { host, timer: setTimeout(cancelIt, 30000) };
  }

  function closePrompt() {
    if (!prompt) return;
    clearTimeout(prompt.timer);
    prompt.host.remove();
    prompt = null;
  }

  // The background accepted the session: start reporting for the TV window.
  function start(s) {
    if (failed) return; // the move already failed; the session is ending
    session = s;
    active = true;
    wantedPlay = null;
    resumes = [];
    lastT = null;
    stuckSince = 0;
    timers.push(setInterval(() => report('tick'), 500));
    report('start');
  }

  // This page reloaded while presenting: find the TV window again. Safari's
  // pop-up blocker lets window.open reach an existing named window without a
  // click. A MediaSource stream was fed by the page that just unloaded, so
  // only a plain-file video can carry on.
  async function resume(s) {
    if (active) return;
    failed = false;
    if (!s.moveName) return lost('controller-reloaded', { found: false });
    let w = null;
    try { w = window.open('', s.moveName); } catch {}
    const v = w && !w.closed ? w.document.querySelector('video[data-ytpm-moved]') : null;
    if (!v) {
      // Not found; with pop-ups allowed that call opened a fresh empty window.
      try { w?.close(); } catch {}
      return lost('controller-reloaded', { found: !!w });
    }
    const src = v.currentSrc || v.src || '';
    if (src.startsWith('blob:')) return lost('controller-reloaded', { found: true, mediaSource: true });
    const t0 = v.currentTime;
    await sleep(1200);
    if (v.error || (!v.paused && v.currentTime < t0 + 0.3) || (v.paused && v.readyState < 2)) {
      return lost('controller-reloaded', { found: true, stopped: true, error: v.error?.code ?? null });
    }
    pw = w;
    video = v;
    home = null;
    savedStyle = null;
    filledStyle = null;
    movedAt = 0;
    pw.addEventListener('pagehide', onTvClosing);
    bindVideo(v);
    start(s);
    event('move-resumed', { t: v.currentTime });
  }

  function lost(reason, data) {
    event('move-lost', { reason, ...data });
    YTPM.sendRetry({ type: 'end', reason });
  }

  // ---- the moved element ------------------------------------------------------------

  const REPORT_ON = ['play', 'pause', 'ratechange', 'volumechange', 'seeked', 'ended'];
  const onVideoEvent = (e) => report(e.type);

  function bindVideo(v) {
    REPORT_ON.forEach((t) => v.addEventListener(t, onVideoEvent));
    v.addEventListener('pause', onPause);
    v.addEventListener('emptied', onReset);
    v.addEventListener('error', onReset);
  }

  function unbindVideo(v) {
    REPORT_ON.forEach((t) => v.removeEventListener(t, onVideoEvent));
    v.removeEventListener('pause', onPause);
    v.removeEventListener('emptied', onReset);
    v.removeEventListener('error', onReset);
  }

  function onReset() {
    if (movedAt && Date.now() - movedAt < RESET_WATCH_MS) fail('move-reset');
  }

  // A feed's script may pause a video it no longer sees on its page (an
  // IntersectionObserver now reports it off-screen). Play on, unless the user
  // paused it: from the remote, or by clicking the site's own controls here.
  function onPause() {
    // Not waiting for the session to start: feeds react within moments.
    if (!video || failed || video.ended || wantedPlay === 'pause' || Date.now() < ourPauseUntil) return;
    if (Date.now() - movedAt > ACTIVATION_GRACE_MS && navigator.userActivation?.isActive) {
      wantedPlay = 'pause';
      return;
    }
    const now = Date.now();
    resumes = resumes.filter((t) => now - t < 60000);
    if (resumes.length >= 4) return void event('move-site-pause-kept', { t: video.currentTime });
    resumes.push(now);
    setTimeout(() => {
      if (!video?.paused || failed || video.ended || wantedPlay === 'pause') return;
      video.play().catch(() => {});
      event('move-resumed-after-site-pause', { t: video.currentTime });
    }, 200);
  }

  // Closing the TV window destroys its document, and the element with it if
  // it's still there: move it back first.
  function onTvClosing() {
    if (video && video.ownerDocument !== document) release();
  }

  // Put the element back where it was (if its spot still exists), paused.
  function release() {
    const v = video;
    if (!v) return;
    try {
      if (home?.isConnected) home.replaceWith(v);
      else if (v.ownerDocument !== document) v.remove(); // the site re-rendered; nowhere to return it to
    } catch {}
    home?.remove();
    if (savedStyle != null) v.style.cssText = savedStyle;
    v.removeAttribute('data-ytpm-moved');
    unbindVideo(v);
    if (!v.paused) {
      ourPauseUntil = Date.now() + 2000;
      try { v.pause(); } catch {}
    }
    video = null;
    home = null;
    savedStyle = null;
    filledStyle = null;
  }

  // Ends move mode here. Returns the TV window (still open unless closeTv).
  function stop({ closeTv = true } = {}) {
    closePrompt();
    active = false;
    timers.forEach(clearInterval);
    timers = [];
    removeOverlay();
    release();
    const w = pw;
    pw = null;
    session = null;
    if (w) {
      try { w.removeEventListener('pagehide', onTvClosing); } catch {}
      if (closeTv) try { w.close(); } catch {}
    }
    return w;
  }

  function fail(reason) {
    if (failed) return;
    failed = true;
    event('move-failed', { reason, t: video?.currentTime ?? null, error: video?.error?.code ?? null });
    stop({ closeTv: false }); // the background closes the window as the session ends
    YTPM.sendRetry({ type: 'end', reason });
  }

  // ---- state reports -------------------------------------------------------------------

  function snapshot() {
    const v = video;
    const live = v ? v.duration === Infinity : false;
    const q = v?.getVideoPlaybackQuality?.();
    const now = Date.now();
    const t = v?.currentTime ?? 0;
    const playing = !!v && !v.paused && !v.ended;
    if (playing && lastT != null && t <= lastT + 0.05) stuckSince = stuckSince || now;
    else stuckSince = 0;
    lastT = t;
    let doc = null;
    try { doc = tvOpen() ? pw.document : null; } catch {}
    return {
      seq: ++seq,
      sentAt: now,
      t,
      d: live ? null : finite(v?.duration),
      paused: v ? v.paused : true,
      ended: !!v?.ended,
      rate: v?.playbackRate ?? 1,
      muted: !!v?.muted,
      vol: v ? Math.round(v.volume * 100) : 100,
      cc: tracks(v).some((tr) => tr.mode === 'showing'),
      ccAvail: tracks(v).length > 0,
      title: site().title(),
      key: session?.key ?? null,
      site: site().id,
      hasNext: false,
      rates: null,
      wireless: false,
      screen: tvOpen() ? YTPM.screenInfo(pw) : null,
      vis: doc?.visibilityState ?? null,
      focus: (() => { try { return !!doc?.hasFocus(); } catch { return false; } })(),
      fs: !!doc?.fullscreenElement,
      frames: q ? { dropped: q.droppedVideoFrames, total: q.totalVideoFrames } : null,
      overlay: overlayKind,
      bridge: null,
      ran: ranCmds.slice(-20),
      live,
      error: v?.error ? 'media error ' + v.error.code : null,
      stalled: !!stuckSince && now - stuckSince > STUCK_MS,
      move: { pageVis: document.visibilityState },
    };
  }

  let reporting = false;
  let reportAgain = false;
  async function report(why) {
    if (!active) return;
    if (reporting) {
      reportAgain = true;
      return;
    }
    reporting = true;
    try {
      if (!tvOpen()) {
        // Closed without a pagehide we saw: recover the element if we can.
        stop({ closeTv: false });
        YTPM.sendRetry({ type: 'end', reason: 'player-closed' });
        return;
      }
      if (video) fill(video);
      const s = snapshot();
      s.why = why;
      const res = await YTPM.send({ type: 'state', state: s });
      if (res?.stale) {
        // The session ended without this tab hearing about it.
        const w = stop({ closeTv: false });
        try { w?.close(); } catch {}
        hooks.ended('player-closed');
        return;
      }
      for (const c of res?.cmds || []) runCmd(c).catch(() => {});
      if (needFullscreen && YTPM.fillsScreen(s.screen)) {
        needFullscreen = false;
        updateOverlay();
      }
    } finally {
      reporting = false;
      if (reportAgain) {
        reportAgain = false;
        report('again');
      }
    }
  }

  // ---- commands (same contract as the player window's) --------------------------------------

  function seekTo(t) {
    if (!video) return;
    const d = finite(video.duration);
    video.currentTime = clamp(t, 0, d ? d - 0.25 : t);
  }

  function setVolume(v) {
    if (!video) return;
    v = clamp(Math.round(v), 0, 100);
    video.volume = v / 100;
    if (v > 0) video.muted = false;
  }

  const A = {
    togglePlay: () => (video?.paused ? A.play() : A.pause()),
    play: async () => {
      if (!video) return;
      try {
        await video.play();
        needGesture = false;
      } catch (e) {
        needGesture = true;
        event('play-blocked', { name: e.name, message: e.message }, true);
      }
      updateOverlay();
    },
    pause: () => {
      if (!video) return;
      ourPauseUntil = Date.now() + 1000;
      video.pause();
    },
    seekBy: (d) => seekTo((video?.currentTime || 0) + d),
    seekTo: (t) => seekTo(t),
    seekPercent: (n) => {
      const d = finite(video?.duration);
      if (d && d < 86400) seekTo((d * n) / 10);
    },
    volumeBy: (d) => setVolume((video?.volume ?? 1) * 100 + d),
    setVolume,
    toggleMute: () => { if (video) video.muted = !video.muted; },
    toggleCaptions: () => {
      const ts = tracks(video);
      const on = ts.some((t) => t.mode === 'showing');
      ts.forEach((t, i) => { t.mode = !on && i === 0 ? 'showing' : 'disabled'; });
    },
    rateStep: (dir) => {
      if (!video || video.duration === Infinity) return;
      const cur = video.playbackRate;
      let i = 0;
      DEFAULT_RATES.forEach((r, k) => { if (Math.abs(r - cur) < Math.abs(DEFAULT_RATES[i] - cur)) i = k; });
      video.playbackRate = DEFAULT_RATES[clamp(i + dir, 0, DEFAULT_RATES.length - 1)];
    },
    setRate: (r) => { if (video && video.duration !== Infinity) video.playbackRate = r; },
    toggleFullscreen: () => YTPM.send({ type: 'toggleWindowFullscreen', exit: YTPM.fillsScreen(YTPM.screenInfo(pw)) }),
    load: () => 'ignored',
    next: () => null,
  };

  // Run each command once, in order, skipping absolute settings older than
  // one already applied (as in player.js).
  const ranCmds = [];
  const GROUPS = { play: 'play', pause: 'play', seekTo: 'pos', seekPercent: 'pos', setRate: 'rate', setVolume: 'vol' };
  const latestSeq = {};
  let cmdChain = Promise.resolve();
  function runCmd(msg) {
    if (msg.id) {
      if (ranCmds.includes(msg.id)) return Promise.resolve({ ok: true, duplicate: true });
      ranCmds.push(msg.id);
      if (ranCmds.length > 100) ranCmds.shift();
    }
    const run = cmdChain.then(() => runCmdNow(msg));
    cmdChain = run.catch(() => {});
    return run;
  }

  async function runCmdNow(msg) {
    const group = GROUPS[msg.action];
    if (group && msg.seq != null) {
      if ((latestSeq[group] ?? -Infinity) > msg.seq) {
        report('cmd');
        return { ok: true, stale: true };
      }
      latestSeq[group] = msg.seq;
    }
    const fn = A[msg.action];
    if (!fn) return { ok: false, error: 'unknown action ' + msg.action };
    if (msg.action === 'play' || msg.action === 'pause') wantedPlay = msg.action;
    const result = await fn(msg.value);
    report('cmd');
    return { ok: true, result: result ?? null };
  }

  // ---- prompts on the TV ---------------------------------------------------------------------

  function updateOverlay() {
    const kind = !tvOpen() ? null : needGesture ? 'gesture'
      : needFullscreen && !YTPM.fillsScreen(YTPM.screenInfo(pw)) ? 'fullscreen' : null;
    if (kind === overlayKind) return;
    removeOverlay();
    overlayKind = kind;
    if (!kind) return;
    const d = pw.document;
    const el = d.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
      'padding:24px;background:rgba(0,0,0,.72);color:#fff;cursor:pointer;text-align:center;' +
      'font:700 40px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;';
    el.textContent = kind === 'gesture' ? 'Click to start playback' : 'Click to go fullscreen';
    el.addEventListener('click', onOverlayClick);
    d.body.append(el);
    overlay = el;
  }

  function removeOverlay() {
    overlay?.remove();
    overlay = null;
    overlayKind = null;
  }

  async function onOverlayClick() {
    if (overlayKind === 'fullscreen') {
      const root = pw.document.documentElement;
      try {
        await (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
        needFullscreen = false;
      } catch (e) {
        event('fullscreen-click-failed', { name: e.name, message: e.message });
      }
    }
    if (video?.paused && wantedPlay !== 'pause') await A.play();
    needGesture = false;
    updateOverlay();
  }

  // ---- messages routed here by the controller ---------------------------------------------------

  function onMessage(msg) {
    switch (msg.type) {
      case 'cmd':
        return active ? runCmd(msg) : { ok: false, notReady: true };
      case 'getState': {
        if (!active) return null;
        const s = snapshot();
        // Ending: put the video back before the background closes the window.
        if (msg.release) stop({ closeTv: false });
        return s;
      }
      case 'needFullscreenClick':
        needFullscreen = true;
        updateOverlay();
        return { ok: true };
    }
    return null;
  }

  return { setHooks, owns, isActive, wanted, begin, start, resume, stop, onMessage };
})();
