// Runs in YouTube's own JS world, where #movie_player exposes its API.
// Talks to the isolated-world content scripts through window.postMessage.
(() => {
  'use strict';
  // If Safari ignores `world: "MAIN"`, this copy lands in the isolated world
  // (where the extension APIs exist). Bail; common.js injects a <script> tag.
  if (globalThis.browser?.runtime?.id || globalThis.chrome?.runtime?.id) return;
  if (window.__ytpmBridge) return;
  window.__ytpmBridge = true;

  let keepAlive = null;

  const player = () => {
    const p = document.getElementById('movie_player');
    if (!p || typeof p.getPlayerState !== 'function') throw new Error('player API not ready');
    return p;
  };

  const ops = {
    hello: () => {
      let api = false;
      try { api = !!player(); } catch {}
      return { mainWorld: true, api };
    },
    // In the player window, keep YouTube's "last activity" fresh so the
    // "Video paused. Continue watching?" prompt never fires on the TV.
    setRole: (role) => {
      clearInterval(keepAlive);
      if (role === 'player') keepAlive = setInterval(() => { window._lact = Date.now(); }, 60_000);
      return true;
    },
    state: () => {
      const p = player();
      const vd = p.getVideoData?.() || {};
      return {
        t: p.getCurrentTime(), d: p.getDuration(), ps: p.getPlayerState(),
        rate: p.getPlaybackRate(), rates: p.getAvailablePlaybackRates?.() || null,
        vol: p.getVolume(), muted: p.isMuted(),
        cc: typeof p.isSubtitlesOn === 'function' ? p.isSubtitlesOn() : null,
        title: vd.title || null, videoId: vd.video_id || null,
        list: p.getPlaylistId?.() || null,
      };
    },
    play: () => player().playVideo(),
    pause: () => player().pauseVideo(),
    seekTo: (t) => player().seekTo(t, true),
    setRate: (r) => player().setPlaybackRate(r),
    setVolume: (v) => player().setVolume(v),
    mute: () => player().mute(),
    unMute: () => player().unMute(),
    toggleCaptions: () => player().toggleSubtitles(),
    next: () => player().nextVideo(),
    loadVideo: ({ videoId, t }) => player().loadVideoById({ videoId, startSeconds: t || 0 }),
  };

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.__ytpm !== 'to-page') return;
    const reply = { __ytpm: 'from-page', id: m.id };
    try {
      const fn = ops[m.op];
      if (!fn) throw new Error('unknown op ' + m.op);
      reply.result = fn(m.args) ?? null;
    } catch (err) {
      reply.error = String(err?.message || err);
    }
    window.postMessage(reply, location.origin);
  });
})();
