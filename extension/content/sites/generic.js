// Any other site with a <video>. The TV window opens the same page and lifts
// that page's main video into the top layer. Controls go through the video
// element itself; captions only when the site uses standard text tracks.
'use strict';
YTPM.registerSite((() => {
  let main = null; // the video picked on this page

  const tracks = (v) => [...(v?.textTracks || [])].filter((t) => t.kind === 'subtitles' || t.kind === 'captions');

  function findVideo() {
    if (main?.isConnected) return main;
    main = YTPM.bestVideo();
    return main;
  }

  return {
    id: 'generic',
    name: 'this site',
    matches: () => true,
    usesBridge: false,
    // In-page navigation on an arbitrary site doesn't reliably mean "a new video".
    followsNavigation: false,
    hasNext: false,
    fill: 'popover',
    fillTarget: (video) => video,
    playerCss: '',
    parse: (href) => ({ key: YTPM.urlKey(href), url: href, t: 0 }),
    playerUrl: (item) => item.url,

    findVideo,
    isMainVideo: (el) => el === main,
    isPlayerVideo: (el) => el === main,
    localVideos: () => (main ? [main] : []),
    shieldHost: () => null,
    insertButton: () => false,

    title: () => document.querySelector('meta[property="og:title"]')?.content?.trim() || document.title,
    currentKey: () => YTPM.urlKey(location.href),
    error: () => (main?.error ? 'media error ' + main.error.code : null),

    captions: {
      available: () => tracks(findVideo()).length > 0,
      on: () => tracks(findVideo()).some((t) => t.mode === 'showing'),
      toggle() {
        const ts = tracks(findVideo());
        const on = ts.some((t) => t.mode === 'showing');
        ts.forEach((t, i) => { t.mode = !on && i === 0 ? 'showing' : 'disabled'; });
      },
      button: () => null,
    },

    playButton: () => null,
    siteThinksPlaying: () => null,
    dismissPrompts: () => null,

    async load(item) {
      YTPM.navigate(item.url);
      return 'navigate';
    },
  };
})());
