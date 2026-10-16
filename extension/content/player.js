// Player role: the window that actually plays. In "extended" mode it sits
// fullscreen on the TV display; in "airplay" mode it stays on the Mac and
// routes its <video> to the Apple TV. Site specifics come from YTPM.site.
'use strict';
YTPM.Player = (() => {
  const { h, bridge, sleep, clamp } = YTPM;
  const site = () => YTPM.site;
  const DEFAULT_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  let session = null;
  let active = false;
  let video = null;
  let seq = 0;
  let lastSentAt = 0;
  let lastTick = 0;
  let reporting = false;
  let timers = [];
  let didInitialPlayback = false;
  let needGesture = false;
  let needFullscreen = false;
  let lastSrcChangeAt = 0;
  let airplayEverConnected = false;
  let overlayKind = null;
  let overlay = null;
  let startedAt = 0;
  // The last play/pause the user sent. A pause sent while this page was still
  // loading must beat YouTube's autoplay and our own initial play.
  let wantedPlay = null;
  let ourPlayUntil = 0;
  let pauseCheck = 0;
  let onCtrlScreenSince = 0;
  const PLACEMENT_HOLD_MS = 1500;

  // Shared CSS for the TV window. Sites that fill with the top layer
  // (popover) mark the element to blow up with data-ytpm-fill and the
  // wrappers between it and the video with data-ytpm-fill-path.
  const BASE_CSS = `
html.ytpm-player, html.ytpm-player body { overflow: hidden !important; background: #000 !important; }
html.ytpm-player [data-ytpm-fill][popover], html.ytpm-player [data-ytpm-fill].ytpm-fill-fixed {
  position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
  max-width: none !important; max-height: none !important; margin: 0 !important; padding: 0 !important;
  border: 0 !important; background: #000 !important; overflow: hidden !important; transform: none !important;
  z-index: 2147483000 !important; display: block !important;
}
html.ytpm-player [data-ytpm-fill]::backdrop { background: #000; }
html.ytpm-player [data-ytpm-fill-path] {
  position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important;
  max-width: none !important; max-height: none !important; margin: 0 !important; padding: 0 !important; transform: none !important;
}
html.ytpm-player [data-ytpm-fill] video { position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important; }
html.ytpm-player [data-ytpm-fill] video, html.ytpm-player video[data-ytpm-fill] { object-fit: contain !important; }
html.ytpm-player [data-ytpm-fill-ancestor] {
  transform: none !important; filter: none !important; perspective: none !important; contain: none !important;
  will-change: auto !important; z-index: 2147483000 !important;
}
html.ytpm-player [data-ytpm-fill], html.ytpm-player [data-ytpm-fill] * { cursor: none !important; }
`;

  const OVERLAY_CSS = `
:host { all: initial; }
.backdrop { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; pointer-events: auto;
  background: rgba(0,0,0,.72); cursor: pointer; color: #fff;
  font: 16px/1.4 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
.card { text-align: center; max-width: 680px; margin: 24px; padding: 40px 48px; border-radius: 28px;
  background: rgba(28,28,30,.94); box-shadow: 0 30px 80px rgba(0,0,0,.6); }
.card svg { width: 72px; height: 72px; }
h1 { font-size: 40px; line-height: 1.15; margin: 16px 0 10px; font-weight: 700; }
p { margin: 0; color: #c7c7cc; font-size: 19px; }
.tip { margin-top: 18px; font-size: 14px; color: #8e8e93; }
.banner { position: fixed; top: 24px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
  max-width: calc(100vw - 48px); background: rgba(28,28,30,.94); color: #fff; padding: 12px 22px;
  border-radius: 999px; font: 600 16px/1.3 -apple-system, BlinkMacSystemFont, sans-serif;
  box-shadow: 0 10px 30px rgba(0,0,0,.5); pointer-events: none; }
`;

  const OVERLAYS = {
    airplay: {
      icon: 'airplay',
      title: 'Send to Apple TV',
      body: 'Click anywhere, then pick your Apple TV in the AirPlay menu.',
      dropped: 'AirPlay disconnected. Click to reconnect.',
    },
    gesture: {
      icon: 'play',
      title: 'Click to start playback',
      body: 'Safari blocked autoplay with sound in this window. One click here fixes it.',
      tip: 'To skip this step: Safari ▸ Settings ▸ Websites ▸ Auto-Play ▸ this site ▸ Allow All Auto-Play.',
    },
    fullscreen: {
      icon: 'fullscreen',
      title: 'Click to go fullscreen',
      body: 'Safari needs one click on this screen to enter fullscreen.',
    },
    placement: {
      banner: 'Drag this window onto your TV. It goes fullscreen when it gets there.',
    },
  };

  // ---- lifecycle -------------------------------------------------------------

  function prepare() {
    document.documentElement.classList.add('ytpm-player');
    if (!document.getElementById('ytpm-player-style')) {
      const s = h('style', { id: 'ytpm-player-style' });
      s.textContent = BASE_CSS + (site().playerCss || '');
      document.documentElement.append(s);
    }
  }

  function unprepare() {
    document.documentElement.classList.remove('ytpm-player');
    clearFill();
  }

  // ---- filling the TV --------------------------------------------------------------
  // Sites using the top layer: their player element is shown as a popover,
  // which escapes every transform, z-index and overflow on the page.
  let fillEl = null;

  function applyFill() {
    if (!active || site().fill !== 'popover' || !video) return;
    const target = site().fillTarget(video) || video;
    if (fillEl && fillEl !== target) clearFill();
    fillEl = target;
    target.setAttribute('data-ytpm-fill', '');
    for (let e = video.parentElement; e && e !== target && target.contains(e); e = e.parentElement) {
      e.setAttribute('data-ytpm-fill-path', '');
    }
    if (typeof target.showPopover === 'function') {
      if (!target.hasAttribute('popover')) target.setAttribute('popover', 'manual');
      try {
        if (!target.matches(':popover-open')) {
          target.showPopover();
          raiseOverlay();
        }
      } catch {}
    } else {
      // No top layer: fixed position, with ancestors that would trap it neutralised.
      target.classList.add('ytpm-fill-fixed');
      for (let e = target.parentElement; e && e !== document.documentElement; e = e.parentElement) {
        e.setAttribute('data-ytpm-fill-ancestor', '');
      }
    }
  }

  function clearFill() {
    if (fillEl) {
      try { if (fillEl.matches(':popover-open')) fillEl.hidePopover(); } catch {}
      fillEl.removeAttribute('popover');
      fillEl.classList.remove('ytpm-fill-fixed');
    }
    for (const a of ['data-ytpm-fill', 'data-ytpm-fill-path', 'data-ytpm-fill-ancestor']) {
      document.querySelectorAll(`[${a}]`).forEach((e) => e.removeAttribute(a));
    }
    fillEl = null;
  }

  function start(hello) {
    session = hello.session;
    active = true;
    startedAt = Date.now();
    prepare();
    bindVideo();
    timers.push(setInterval(bindVideo, 1000));
    timers.push(setInterval(() => report('tick'), 500));
    timers.push(setInterval(dismissPrompts, 5000));
    document.addEventListener('yt-navigate-finish', () => { bindVideo(); report('nav'); });
    document.addEventListener('fullscreenchange', () => { updateOverlay(); report('fullscreen'); });
    document.addEventListener('visibilitychange', () => report('visibility'));
    // Fullscreen changes resize the window; report at once so the background
    // knows promptly whether the player fills its screen.
    window.addEventListener('resize', () => { updateOverlay(); report('resize'); });
    event('player-ready', { bridge: bridge.info, screen: YTPM.screenInfo(), mode: session.mode });
    updateOverlay();
  }

  // The page-world bridge finished loading (or gave up) after start.
  function onBridge() {
    if (!active) return;
    if (bridge.ready) bridge.call('setRole', 'player').catch(() => {});
    event('bridge', bridge.info);
  }

  // Session ended without closing this window (the controller tab went away):
  // hand the window back to normal YouTube.
  function orphan() {
    if (!active) return;
    active = false;
    timers.forEach(clearInterval);
    timers = [];
    overlay?.remove();
    overlay = null;
    unprepare();
    if (bridge.ready) bridge.call('setRole', null).catch(() => {});
  }

  // ---- video binding -----------------------------------------------------------

  function bindVideo() {
    const v = site().findVideo();
    // Re-apply the fill each time: sites re-render their players.
    if (!v || v === video) return void applyFill();
    video = v;
    v.addEventListener('timeupdate', () => { if (Date.now() - lastSentAt > 450) report('timeupdate'); });
    for (const t of ['play', 'pause', 'ratechange', 'volumechange', 'seeked', 'ended']) {
      v.addEventListener(t, () => report(t));
    }
    v.addEventListener('play', () => {
      // YouTube autoplaying a page the user already paused from the remote.
      if (wantedPlay === 'pause' && Date.now() > ourPlayUntil && Date.now() - startedAt < 10000) v.pause();
    });
    for (const t of ['emptied', 'loadstart']) {
      v.addEventListener(t, () => { lastSrcChangeAt = Date.now(); });
    }
    // Listening for availability is also what makes WebKit start scanning for AirPlay targets.
    v.addEventListener('webkitplaybacktargetavailabilitychanged', (e) =>
      event('airplay-availability', { availability: e.availability }));
    v.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', onWirelessChange);
    for (const t of ['connecting', 'connect', 'disconnect']) {
      v.remote?.addEventListener?.(t, () => event('remote-playback-' + t, { state: v.remote.state }));
    }
    event('video-bound', {
      disableRemotePlayback: v.disableRemotePlayback ?? null,
      xWebkitAirplay: v.getAttribute('x-webkit-airplay'),
      srcIsBlob: (v.currentSrc || v.src || '').startsWith('blob:'),
      hasManagedMediaSource: typeof globalThis.ManagedMediaSource === 'function',
      remoteState: v.remote?.state ?? null,
    });
    applyFill();
    if (!didInitialPlayback) {
      // Through the command queue, so commands that arrive meanwhile run after it.
      const queueInitial = () => { cmdChain = cmdChain.then(initialPlayback).catch(() => {}); };
      if (v.readyState >= 1) queueInitial();
      else v.addEventListener('loadedmetadata', queueInitial, { once: true });
    }
  }

  async function initialPlayback() {
    if (didInitialPlayback || !video) return;
    didInitialPlayback = true;
    // Only resume a position meant for the video this page is showing (after
    // an autoplay-next and a reload, the URL is a different video), never on a
    // live stream, and on generic sites only if it's evidently the same video
    // (a pre-roll, say, has a different length).
    const sameVideo = site().currentKey() === session.key;
    const finiteVideo = Number.isFinite(video.duration);
    const sameLength = !session.d || !finiteVideo || Math.abs(video.duration - session.d) < 3;
    const t = sameVideo && finiteVideo && sameLength ? session.startT || 0 : 0;
    if (t > 1 && Math.abs(video.currentTime - t) > 2) await seekTo(t);
    // In AirPlay mode, wait for the user's click so audio doesn't start on the Mac first.
    if (session.mode === 'airplay') return updateOverlay();
    await setMuted(false);
    if (wantedPlay === 'pause') return A.pause();
    await A.play();
  }

  const isWireless = () =>
    !!(video?.webkitCurrentPlaybackTargetIsWireless || video?.remote?.state === 'connected');

  function onWirelessChange() {
    const wireless = isWireless();
    if (wireless) airplayEverConnected = true;
    event(wireless ? 'airplay-connected' : 'airplay-disconnected', {
      visibility: document.visibilityState,
      focus: document.hasFocus(),
      paused: video?.paused,
      readyState: video?.readyState,
      msSinceSourceChange: lastSrcChangeAt ? Date.now() - lastSrcChangeAt : null,
      remoteState: video?.remote?.state ?? null,
    }, true);
    if (wireless && video?.paused) A.play();
    updateOverlay();
    report('wireless');
  }

  function pickAirPlay() {
    const v = video;
    if (!v) return;
    try { v.disableRemotePlayback = false; } catch {}
    v.setAttribute('x-webkit-airplay', 'allow');
    if (typeof v.webkitShowPlaybackTargetPicker === 'function') {
      v.webkitShowPlaybackTargetPicker();
      event('airplay-picker', { api: 'webkitShowPlaybackTargetPicker' });
    } else if (v.remote?.prompt) {
      v.remote.prompt().catch((e) => event('airplay-picker-failed', { name: e.name, message: e.message }));
      event('airplay-picker', { api: 'remote.prompt' });
    } else {
      event('airplay-picker-failed', { reason: 'no AirPlay API on this video element' });
    }
  }

  // Prompts nobody is at the TV to answer ("Continue watching?", content gates).
  function dismissPrompts() {
    const what = site().dismissPrompts?.();
    if (!what) return;
    event('prompt-dismissed', { what });
    if (video?.paused && wantedPlay !== 'pause') A.play();
  }

  // ---- state reporting -----------------------------------------------------------

  const finite = (n) => (Number.isFinite(n) ? n : null);
  const isLive = () => (video ? video.duration === Infinity || lastLive : false);
  let lastLive = false;

  async function snapshot() {
    const v = video;
    const cc = site().captions;
    const q = v?.getVideoPlaybackQuality?.();
    const s = {
      seq: ++seq,
      sentAt: Date.now(),
      t: v?.currentTime ?? 0,
      d: finite(v?.duration),
      paused: v ? v.paused : true,
      ended: !!v?.ended,
      rate: v?.playbackRate ?? 1,
      muted: !!v?.muted,
      vol: v ? Math.round(v.volume * 100) : 100,
      cc: !!cc?.on(),
      ccAvail: !!cc?.available(),
      title: site().title(),
      key: site().currentKey(),
      site: site().id,
      hasNext: !!site().hasNext,
      rates: null,
      wireless: isWireless(),
      screen: YTPM.screenInfo(),
      vis: document.visibilityState,
      focus: document.hasFocus(),
      fs: !!document.fullscreenElement,
      frames: q ? { dropped: q.droppedVideoFrames, total: q.totalVideoFrames } : null,
      overlay: overlayKind,
      bridge: bridge.info,
      ran: ranCmds.slice(-20),
      live: v ? v.duration === Infinity : false,
      error: site().error(),
    };
    if (bridge.ready) {
      try {
        const b = await bridge.call('state', null, 400);
        s.vol = b.vol;
        s.muted = b.muted;
        if (b.cc != null) s.cc = b.cc;
        s.title = b.title || s.title;
        s.key = b.videoId || s.key;
        if (b.live || (b.d > 86400 && !Number.isFinite(v?.duration))) s.live = true;
        s.error = b.error || s.error;
        s.rates = b.rates;
        if (s.d == null) s.d = finite(b.d);
      } catch {}
    }
    if (s.live) s.d = null;
    lastLive = s.live;
    return s;
  }

  // A report requested while one is in flight runs right after it, so play,
  // pause and command results reach the controller without waiting a tick.
  let reportAgain = false;
  async function report(why) {
    if (!active) return;
    if (reporting) {
      reportAgain = true;
      return;
    }
    reporting = true;
    try {
      const s = await snapshot();
      s.why = why;
      if (why === 'tick') {
        s.tickGap = lastTick ? s.sentAt - lastTick : 0;
        lastTick = s.sentAt;
      }
      lastSentAt = Date.now();
      const res = await YTPM.send({ type: 'state', state: s });
      if (res?.stale) orphan();
      // Commands the background couldn't deliver directly ride on this reply.
      for (const c of res?.cmds || []) runCmd(c).catch(() => {});
      if (YTPM.fillsScreen(s.screen) && needFullscreen) {
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

  function event(name, data, notify = false) {
    YTPM.send({ type: 'event', name, data: data ?? null, notify });
  }

  // ---- actions -----------------------------------------------------------------------

  const duration = () => finite(video?.duration);

  async function seekTo(t) {
    if (!video) return;
    const d = duration();
    t = clamp(t, 0, d ? d - 0.25 : t);
    if (bridge.ready) {
      try { return void (await bridge.call('seekTo', t)); } catch {}
    }
    video.currentTime = t;
  }

  async function volume() {
    if (bridge.ready) {
      try {
        const s = await bridge.call('state', null, 400);
        return { vol: s.vol, muted: s.muted };
      } catch {}
    }
    return { vol: Math.round((video?.volume ?? 1) * 100), muted: !!video?.muted };
  }

  async function setMuted(m) {
    if (bridge.ready) {
      try { return void (await bridge.call(m ? 'mute' : 'unMute')); } catch {}
    }
    if (video) video.muted = m;
  }

  async function setVolume(v) {
    v = clamp(Math.round(v), 0, 100);
    if (bridge.ready) {
      try {
        await bridge.call('setVolume', v);
        if (v > 0) await bridge.call('unMute');
        return;
      } catch {}
    }
    if (!video) return;
    video.volume = v / 100;
    if (v > 0) video.muted = false;
  }

  async function ccState() {
    if (bridge.ready) {
      try {
        const s = await bridge.call('state', null, 400);
        if (s.cc != null) return s.cc;
      } catch {}
    }
    return !!site().captions?.on();
  }

  // Captions go through the player API, falling back to the site's own
  // (hidden) CC button or the video's text tracks. A synthetic "c" keypress
  // proved unreliable.
  async function toggleCaptions() {
    if (bridge.ready) {
      const before = await ccState();
      try {
        await bridge.call('toggleCaptions');
        await sleep(300);
        if ((await ccState()) !== before) return 'api';
      } catch {}
    }
    site().captions?.toggle();
    return 'site';
  }

  async function availableRates() {
    if (bridge.ready) {
      try {
        const s = await bridge.call('state', null, 400);
        if (s.rates?.length) return s.rates;
      } catch {}
    }
    return DEFAULT_RATES;
  }

  async function setRate(r) {
    if (isLive()) return; // live streams play at 1×
    if (bridge.ready) {
      try { return void (await bridge.call('setRate', r)); } catch {}
    }
    if (video) video.playbackRate = r;
  }

  async function loadVideo(item) {
    if (!item?.key) return 'ignored';
    return site().load(item);
  }

  const A = {
    togglePlay: () => (video?.paused ? A.play() : A.pause()),
    play: async () => {
      if (!video) return;
      try {
        pauseCheck++;
        ourPlayUntil = Date.now() + 2000;
        // Playing the element directly lets us see Safari's autoplay refusal.
        await video.play();
        needGesture = false;
        // Then bring the site's own player state in line, or it may pause again.
        // (Not via its button: that's a toggle and could undo the play.)
        if (bridge.ready) await bridge.call('play').catch(() => {});
      } catch (e) {
        needGesture = true;
        event('play-blocked', { name: e.name, message: e.message }, true);
      }
      updateOverlay();
    },
    // Pausing only the <video> can leave the site's player believing it's
    // playing, so it may resume by itself. Pause through the site (API, else
    // its button), then make sure it held.
    pause: async () => {
      if (!video) return;
      if (bridge.ready) await bridge.call('pause').catch(() => {});
      else if (site().siteThinksPlaying?.()) site().playButton?.()?.click();
      if (!video.paused) video.pause();
      // Check it held a moment later, without holding up the next command;
      // a play that arrives meanwhile cancels the check.
      const token = ++pauseCheck;
      setTimeout(() => {
        if (token !== pauseCheck || wantedPlay === 'play' || !video || video.paused) return;
        video.pause();
        event('pause-retried', { bridge: bridge.ready, siteThinksPlaying: site().siteThinksPlaying?.() ?? null });
      }, 500);
    },
    seekBy: (d) => seekTo((video?.currentTime || 0) + d),
    seekTo: (t) => seekTo(t),
    seekPercent: (n) => {
      const d = duration();
      if (!isLive() && d && d < 86400) return seekTo((d * n) / 10);
    },
    volumeBy: async (d) => {
      const cur = await volume();
      return setVolume(cur.vol + d);
    },
    setVolume: (v) => setVolume(v),
    toggleMute: async () => setMuted(!(await volume()).muted),
    toggleCaptions,
    rateStep: async (dir) => {
      const rates = await availableRates();
      const cur = video?.playbackRate ?? 1;
      let i = 0;
      rates.forEach((r, k) => { if (Math.abs(r - cur) < Math.abs(rates[i] - cur)) i = k; });
      return setRate(rates[clamp(i + dir, 0, rates.length - 1)]);
    },
    setRate: (r) => setRate(r),
    toggleFullscreen: async () => {
      if (document.fullscreenElement) return void (await document.exitFullscreen().catch(() => {}));
      // This page knows whether it fills its screen; Safari's window.state may not.
      return YTPM.send({ type: 'toggleWindowFullscreen', exit: YTPM.fillsScreen(YTPM.screenInfo()) });
    },
    load: loadVideo,
    next: () => site().next?.() ?? null,
  };

  // ---- overlay -------------------------------------------------------------------------

  function computeOverlay() {
    if (!active) return null;
    if (session.mode === 'airplay') {
      if (!isWireless()) return 'airplay';
      return needGesture ? 'gesture' : null;
    }
    if (needGesture) return 'gesture';
    const scr = YTPM.screenInfo();
    // Only once it has held: moving into or out of fullscreen can briefly
    // report the main display.
    if (session.ctrlScreen && YTPM.sameScreen(scr, session.ctrlScreen)) {
      if (!onCtrlScreenSince) {
        onCtrlScreenSince = Date.now();
        setTimeout(updateOverlay, PLACEMENT_HOLD_MS + 50);
      }
      if (Date.now() - onCtrlScreenSince >= PLACEMENT_HOLD_MS) return 'placement';
    } else {
      onCtrlScreenSince = 0;
    }
    if (needFullscreen && !document.fullscreenElement && !YTPM.fillsScreen(scr)) return 'fullscreen';
    return null;
  }

  function updateOverlay() {
    const kind = computeOverlay();
    if (kind === overlayKind && (overlay || !kind)) return;
    overlayKind = kind;
    overlay?.remove();
    overlay = null;
    if (!kind) return;
    const spec = OVERLAYS[kind];
    const host = h('div', { id: 'ytpm-overlay-host' });
    const root = host.attachShadow({ mode: 'open' });
    const style = h('style');
    style.textContent = OVERLAY_CSS;
    root.append(style);
    if (spec.banner) {
      root.append(h('div', { class: 'banner' }, spec.banner));
    } else {
      const body = kind === 'airplay' && airplayEverConnected ? spec.dropped : spec.body;
      root.append(h('div', { class: 'backdrop', onclick: onOverlayClick },
        h('div', { class: 'card' },
          YTPM.icon(spec.icon, 72),
          h('h1', {}, spec.title),
          h('p', {}, body),
          spec.tip ? h('p', { class: 'tip' }, spec.tip) : null)));
    }
    document.documentElement.append(host);
    overlay = host;
    raiseOverlay();
  }

  // Our prompts sit in the top layer too, above a filled player.
  function raiseOverlay() {
    const host = overlay;
    if (!host || typeof host.showPopover !== 'function') return;
    try {
      if (!host.hasAttribute('popover')) {
        host.setAttribute('popover', 'manual');
        host.style.cssText = 'all:unset;display:block;position:fixed;inset:0;width:100vw;height:100vh;' +
          'pointer-events:none;background:transparent;overflow:visible;z-index:2147483647;';
      }
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch {}
  }

  async function onOverlayClick() {
    const kind = overlayKind;
    if (kind === 'airplay') pickAirPlay();
    if (kind === 'fullscreen') {
      try {
        // With a top-layer fill, fullscreen the filled element itself.
        await (fillEl && site().fill === 'popover' ? fillEl : document.documentElement).requestFullscreen();
        needFullscreen = false;
      } catch (e) {
        event('fullscreen-click-failed', { name: e.name, message: e.message });
      }
    }
    // Playing inside the click is what unlocks audio for later, script-driven plays.
    if (video) {
      video.muted = false;
      await setMuted(false);
      if (video.paused || kind === 'gesture') await A.play();
    }
    updateOverlay();
  }

  // ---- self-test: which control paths work in this Safari? -------------------------------

  const KEYCODES = { c: ['KeyC', 67], k: ['KeyK', 75], '>': ['Period', 190] };
  function syntheticKey(key) {
    const [code, keyCode] = KEYCODES[key];
    const init = { key, code, keyCode, which: keyCode, shiftKey: key === '>', bubbles: true, cancelable: true, composed: true };
    document.dispatchEvent(new KeyboardEvent('keydown', init));
    document.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  async function selftest() {
    const R = { at: Date.now(), bridge: bridge.info, results: [] };
    const rec = (test, method, before, after, note) =>
      R.results.push({ test, method, before, after, works: before !== after, note: note ?? null });
    if (!video) return { ...R, error: 'no video element' };

    // Captions
    const ccButton = () => site().captions?.button?.();
    const btn = ccButton();
    if (!btn || getComputedStyle(btn).display === 'none') {
      R.results.push({ test: 'captions', note: 'this video has no captions; rerun on a captioned video' });
    } else {
      const methods = [
        ['player API', () => bridge.call('toggleCaptions'), bridge.ready],
        ['CC button click', () => ccButton().click(), true],
        ['synthetic "c" key', () => syntheticKey('c'), true],
      ];
      for (const [name, fn, available] of methods) {
        if (!available) { R.results.push({ test: 'captions', method: name, note: 'page bridge unavailable' }); continue; }
        const before = await ccState();
        try { await fn(); } catch (e) { rec('captions', name, before, before, e.message); continue; }
        await sleep(600);
        const after = await ccState();
        rec('captions', name, before, after);
        if (after !== before) { ccButton().click(); await sleep(600); }
      }
    }

    // Speed: check the change is applied and that YouTube doesn't reset it.
    const r0 = video.playbackRate;
    const rateMethods = [
      ['player API', () => bridge.call('setRate', 1.5), bridge.ready],
      ['video.playbackRate', () => { video.playbackRate = 1.25; }, true],
      ['synthetic ">" key', () => syntheticKey('>'), true],
    ];
    for (const [name, fn, available] of rateMethods) {
      if (!available) { R.results.push({ test: 'speed', method: name, note: 'page bridge unavailable' }); continue; }
      await setRate(r0);
      await sleep(300);
      const before = video.playbackRate;
      try { await fn(); } catch (e) { rec('speed', name, before, before, e.message); continue; }
      await sleep(1500);
      rec('speed', name, before, video.playbackRate, 'value 1.5s later');
    }
    await setRate(r0);

    // Play/pause via synthetic key vs. the element.
    for (const [name, fn] of [['synthetic "k" key', () => syntheticKey('k')], ['video.play/pause', () => (video.paused ? video.play() : video.pause())]]) {
      const before = video.paused;
      try { await fn(); } catch (e) { rec('play/pause', name, before, before, e.message); continue; }
      await sleep(600);
      const after = video.paused;
      rec('play/pause', name, before, after);
      if (after !== before) { after ? await A.play() : video.pause(); await sleep(400); }
    }

    // Volume via the player API.
    if (bridge.ready) {
      const v0 = (await volume()).vol;
      const target = v0 > 50 ? v0 - 20 : v0 + 20;
      await setVolume(target);
      await sleep(300);
      rec('volume', 'player API', v0, (await volume()).vol);
      await setVolume(v0);
    }
    event('selftest', R);
    return R;
  }

  // ---- messages from the background ---------------------------------------------------

  // A command can arrive twice (direct retry, then the queued copy); run it once.
  // Commands that set an absolute value can also arrive out of order; an
  // older one is skipped so the latest play/pause, seek or setting wins.
  const ranCmds = [];
  const GROUPS = { play: 'play', pause: 'play', seekTo: 'pos', seekPercent: 'pos', setRate: 'rate', setVolume: 'vol', load: 'load' };
  const latestSeq = {};
  // Commands run one at a time, in arrival order: a pause still checking that
  // it held must not overlap the play that follows it.
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

  async function onMessage(msg) {
    switch (msg.type) {
      case 'cmd':
        return runCmd(msg);
      case 'getState':
        return snapshot();
      case 'selftest':
        return selftest();
      case 'needFullscreenClick':
        needFullscreen = true;
        updateOverlay();
        return { ok: true };
      case 'session':
        session = msg.session;
        return { ok: true };
      case 'orphaned':
        orphan();
        return { ok: true };
    }
    return { ok: false, error: 'unhandled ' + msg.type };
  }

  return { prepare, unprepare, start, onBridge, onMessage };
})();
