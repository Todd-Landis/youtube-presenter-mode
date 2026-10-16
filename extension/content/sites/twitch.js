// Twitch: live channels, past broadcasts (VODs) and clips. Twitch's player is
// a plain <video> inside [data-a-target="video-player"], under an ancestor
// with a CSS transform, so on the TV it is lifted into the top layer.
'use strict';
YTPM.registerSite((() => {
  // First path segments that are Twitch pages, not channels.
  const RESERVED = new Set(['directory', 'settings', 'subscriptions', 'inventory', 'wallet', 'drops', 'search',
    'downloads', 'jobs', 'p', 'store', 'turbo', 'prime', 'friends', 'messages', 'following', 'videos', 'u',
    'login', 'signup', 'payments', 'bits', 'moderator', 'popout', 'embed', 'dashboard', 'team', 'collections']);

  function parse(href) {
    try {
      const u = new URL(href);
      const parts = u.pathname.split('/').filter(Boolean);
      const t = YTPM.parseTime(u.searchParams.get('t'));
      if (u.hostname === 'clips.twitch.tv' && parts[0]) {
        return { key: 'clip:' + parts[0], url: `https://clips.twitch.tv/${parts[0]}`, t: 0 };
      }
      if (parts[0] === 'videos' && /^\d+$/.test(parts[1] || '')) {
        return { key: 'vod:' + parts[1], url: `https://www.twitch.tv/videos/${parts[1]}`, t };
      }
      if (parts[1] === 'clip' && parts[2]) {
        return { key: 'clip:' + parts[2], url: `https://www.twitch.tv/${parts[0]}/clip/${parts[2]}`, t: 0 };
      }
      if (parts.length === 1 && /^[a-z0-9_]{2,25}$/i.test(parts[0]) && !RESERVED.has(parts[0].toLowerCase())) {
        const ch = parts[0].toLowerCase();
        return { key: 'live:' + ch, url: `https://www.twitch.tv/${ch}`, t: 0 };
      }
    } catch {}
    return null;
  }

  const player = () => document.querySelector('[data-a-target="video-player"]');
  const ccButton = () =>
    document.querySelector('[data-a-target="player-closed-captions-button"], [data-a-target="player-captions-button"]');
  const playButton = () => document.querySelector('[data-a-target="player-play-pause-button"]');

  return {
    id: 'twitch',
    name: 'Twitch',
    matches: (u) => /(^|\.)twitch\.tv$/.test(u.hostname),
    usesBridge: false,
    followsNavigation: true,
    hasNext: false,
    fill: 'popover',
    fillTarget: (video) => video.closest('[data-a-target="video-player"]') || video,
    playerCss: `
html.ytpm-player [data-ytpm-fill] :is([data-a-target="player-controls"], [data-a-target="player-overlay-click-handler"],
  .top-bar, .player-overlay-background, .disclosure-tool, .extensions-dock__layout, .extensions-notifications,
  .celebration__overlay) { opacity: 0 !important; pointer-events: none !important; }
`,
    parse,

    playerUrl(item, t) {
      if (item.key.startsWith('vod:') && t > 1) return `${item.url}?t=${YTPM.hms(t)}`;
      return item.url;
    },

    findVideo: () => player()?.querySelector('video') || YTPM.bestVideo(),
    isMainVideo: (el) => !!el.closest?.('[data-a-target="video-player"]'),
    isPlayerVideo: (el) => !!el.closest?.('[data-a-target="video-player"]'),
    localVideos: () => [...document.querySelectorAll('[data-a-target="video-player"] video')],
    shieldHost: player,

    insertButton(btn) {
      const group = document.querySelector('.player-controls__right-control-group');
      if (!group) return false;
      btn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;' +
        'padding:0;border:0;border-radius:4px;background:transparent;color:#fff;cursor:pointer;';
      const wrap = YTPM.h('div', { id: 'ytpm-btn-wrap', style: 'display:inline-flex;align-items:center;margin:0 2px;' }, btn);
      const fs = group.querySelector('[data-a-target="player-fullscreen-button"]');
      const fsWrap = fs && [...group.children].find((c) => c.contains(fs));
      group.insertBefore(wrap, fsWrap || null);
      return true;
    },

    title: () => document.title.replace(/ - Twitch$/, ''),
    currentKey: () => parse(location.href)?.key ?? null,

    error() {
      const offline = document.querySelector('[data-a-target="player-overlay-offline"], .offline-recommendations-video-card');
      return offline ? 'channel offline' : null;
    },

    captions: {
      available: () => !!ccButton(),
      on: () => ccButton()?.getAttribute('aria-pressed') === 'true' || ccButton()?.getAttribute('data-a-player-state') === 'on',
      toggle: () => ccButton()?.click(),
      button: ccButton,
    },

    playButton,
    siteThinksPlaying() {
      const state = playButton()?.getAttribute('data-a-player-state');
      return state ? state === 'playing' : null;
    },

    // Mature-content gates: the stream was already chosen on the Mac.
    dismissPrompts() {
      const accept = document.querySelector('[data-a-target="player-overlay-mature-accept"], ' +
        '[data-a-target="content-classification-gate-overlay-start-watching-button"]');
      if (accept) {
        accept.click();
        return 'content-gate';
      }
      return null;
    },

    async load(item) {
      YTPM.navigate(item.url);
      return 'navigate';
    },
  };
})());
