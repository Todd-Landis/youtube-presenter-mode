// YouTube: watch pages, Shorts and live links. Uses YouTube's own player
// (#movie_player) through the page-world bridge when it loads.
'use strict';
YTPM.registerSite((() => {
  const { bridge } = YTPM;

  const PLAYER_CSS = `
html.ytpm-player :is(#masthead-container, ytd-masthead, tp-yt-app-drawer, ytd-mini-guide-renderer, #secondary, #below, #chat) { visibility: hidden !important; }
html.ytpm-player #movie_player {
  position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
  max-width: none !important; max-height: none !important; margin: 0 !important;
  z-index: 2147483000 !important; background: #000 !important;
}
html.ytpm-player #movie_player .html5-video-container { position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important; }
html.ytpm-player #movie_player video.html5-main-video {
  position: absolute !important; left: 0 !important; top: 0 !important;
  width: 100% !important; height: 100% !important; object-fit: contain !important;
}
html.ytpm-player #movie_player :is(.ytp-chrome-top, .ytp-chrome-bottom, .ytp-gradient-top, .ytp-gradient-bottom,
  .ytp-pause-overlay, .ytp-ce-element, .ytp-cards-teaser, .ytp-cards-button, .ytp-watermark,
  .ytp-paid-content-overlay, .ytp-tooltip, .ytp-bezel, .ytp-bezel-text-wrapper, .ytp-overlay-bottom-right,
  .ytp-suggested-action, .ytp-iv-player-content) { opacity: 0 !important; pointer-events: none !important; }
html.ytpm-player #movie_player, html.ytpm-player #movie_player * { cursor: none !important; }
`;

  // Watch, Shorts and live URLs.
  function parse(href) {
    try {
      const u = new URL(href);
      const q = u.searchParams;
      const path = u.pathname.match(/^\/(?:shorts|live)\/([\w-]{6,})/);
      const id = u.pathname === '/watch' ? q.get('v') : path ? path[1] : null;
      if (!id) return null;
      return { key: id, url: href, t: YTPM.parseTime(q.get('t') || q.get('start')), list: q.get('list'), index: q.get('index') };
    } catch {
      return null;
    }
  }

  const ccButton = () => document.querySelector('#movie_player .ytp-subtitles-button');
  const playButton = () => document.querySelector('#movie_player .ytp-play-button');

  return {
    id: 'youtube',
    name: 'YouTube',
    matches: (u) => /(^|\.)youtube\.com$/.test(u.hostname),
    usesBridge: true,
    followsNavigation: true,
    hasNext: true,
    fill: 'css',
    playerCss: PLAYER_CSS,
    parse,

    playerUrl(item, t) {
      const u = new URL('https://www.youtube.com/watch');
      u.searchParams.set('v', item.key);
      if (item.list) u.searchParams.set('list', item.list);
      if (item.index) u.searchParams.set('index', item.index);
      if (t > 1) u.searchParams.set('t', Math.floor(t) + 's');
      return u.href;
    },

    findVideo: () =>
      document.querySelector('#movie_player video.html5-main-video') ||
      document.querySelector('#movie_player video'),
    isMainVideo: (el) => !!el.closest?.('#movie_player'),
    // The watch-page player and the Shorts player; both would play with sound.
    isPlayerVideo: (el) => !!el.closest?.('#movie_player, #shorts-player'),
    localVideos: () => [...document.querySelectorAll('#movie_player video, #shorts-player video')],
    shieldHost: () => document.getElementById('movie_player'),

    insertButton(btn) {
      const bar = document.querySelector('#movie_player .ytp-right-controls-right') ||
        document.querySelector('#movie_player .ytp-right-controls');
      if (!bar) return false;
      btn.className = 'ytp-button';
      btn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;';
      bar.insertBefore(btn, bar.querySelector(':scope > .ytp-fullscreen-button'));
      return true;
    },

    // (The bridge's richer title and video ID are merged in by the player.)
    title: () => document.querySelector('ytd-watch-metadata h1')?.textContent?.trim() ||
      document.title.replace(/ - YouTube$/, ''),
    currentKey: () => parse(location.href)?.key ?? null,

    // YouTube's error screen ("Video unavailable" and the like).
    error() {
      const el = document.querySelector('#movie_player .ytp-error');
      if (!el || getComputedStyle(el).display === 'none') return null;
      return el.querySelector('.ytp-error-content-wrap-reason')?.textContent?.trim() || 'unavailable';
    },

    captions: {
      available: () => { const b = ccButton(); return !!b && getComputedStyle(b).display !== 'none'; },
      on: () => ccButton()?.getAttribute('aria-pressed') === 'true',
      toggle: () => ccButton()?.click(),
      button: ccButton,
    },

    // Its label says "Pause" while YouTube itself considers the video playing.
    playButton,
    siteThinksPlaying() {
      const b = playButton();
      const label = b && (b.getAttribute('data-title-no-tooltip') || b.getAttribute('aria-label') || b.title || '');
      return label ? /^pause/i.test(label) : null;
    },

    // "Video paused. Continue watching?": nobody is at the TV to click it.
    dismissPrompts() {
      const dialogs = document.querySelectorAll(
        'ytd-popup-container yt-confirm-dialog-renderer, ytd-popup-container ytd-confirm-dialog-renderer');
      for (const d of dialogs) {
        if (!d.offsetParent || !/continue watching|still watching/i.test(d.textContent || '')) continue;
        const btn = d.querySelector('#confirm-button button, #confirm-button');
        if (!btn) continue;
        btn.click();
        return 'still-watching';
      }
      return null;
    },

    // Single videos switch in place through the player API; playlists (and
    // pages without the bridge) take a full load, which window fullscreen survives.
    async load(item) {
      if (!item.list && bridge.ready) {
        try {
          await bridge.call('loadVideo', { videoId: item.key, t: item.t });
          return 'api';
        } catch {}
      }
      YTPM.navigate(item.url);
      return 'navigate';
    },
    next: () => (bridge.ready ? bridge.call('next') : null),
  };
})());
