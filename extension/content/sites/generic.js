// Any other site with a <video>. The TV window opens the same page and lifts
// that page's main video into the top layer. Controls go through the video
// element itself; captions only when the site uses standard text tracks.
// When the site's player has its own control bar, the presenter button goes
// next to its fullscreen button, and the paused Mac player is covered.
'use strict';
YTPM.registerSite((() => {
  let main = null; // the video picked on this page
  let root = null; // the site's player box: the video plus its control bar
  let miss = { video: null, at: 0 };

  const tracks = (v) => [...(v?.textTracks || [])].filter((t) => t.kind === 'subtitles' || t.kind === 'captions');

  function findVideo() {
    if (main?.isConnected) return main;
    main = YTPM.bestVideo();
    return main;
  }

  // ---- the site's own control bar ----------------------------------------------------
  // Most players label their fullscreen button (Video.js, JW Player, Plyr,
  // Shaka, Bitmovin…). Some draw unlabelled icons (Kick), but put fullscreen
  // last in the bottom bar, as nearly every player does.
  const FULLSCREEN = /full\s*-?\s*screen|vollbild|plein\s+[ée]cran|pantalla\s+completa|schermo\s+intero/i;
  const BUTTONS = 'button, [role="button"]';
  const area = (r) => r.width * r.height;

  function labelOf(b) {
    const text = b.textContent.length < 40 ? b.textContent : '';
    // Plain class names only: utility-class sites put state variants such as
    // group-data-[fullscreen=true]:… on all sorts of elements.
    const classes = (b.getAttribute('class') || '').split(/\s+/).filter((c) => !/[[:]/.test(c)).join(' ');
    return ['aria-label', 'title', 'data-title', 'data-tooltip', 'data-plyr', 'data-a-target']
      .map((a) => b.getAttribute(a) || '').join(' ') + ' ' + classes + ' ' + text;
  }

  // The right-most button of the lowest row of at least three buttons lying
  // over the bottom quarter of the video: its control bar.
  function bottomRight(v, el) {
    const vr = v.getBoundingClientRect();
    if (!area(vr)) return null;
    const cands = [...el.querySelectorAll(BUTTONS)]
      .filter((b) => b.id !== 'ytpm-btn')
      .map((b) => ({ b, r: b.getBoundingClientRect() }))
      .filter(({ r }) => area(r) && r.left >= vr.left - 1 && r.right <= vr.right + 1 &&
        r.top + r.height / 2 >= vr.top + vr.height * 0.75 && r.bottom <= vr.bottom + 4);
    if (cands.length < 3) return null;
    const mid = ({ r }) => r.top + r.height / 2;
    const lowest = Math.max(...cands.map(mid));
    const row = cands.filter((c) => Math.abs(mid(c) - lowest) <= 12);
    return row.length < 3 ? null : row.reduce((a, c) => (c.r.right > a.r.right ? c : a)).b;
  }

  // Walk up from the video until an ancestor holds a fullscreen control,
  // without passing into a box that holds another player or is much bigger.
  function siteControls(v) {
    const vr = v.getBoundingClientRect();
    for (let el = v.parentElement, depth = 0; el && el !== document.body && depth < 8; el = el.parentElement, depth++) {
      if (area(vr) && area(el.getBoundingClientRect()) > area(vr) * 3) return null;
      const others = [...el.querySelectorAll('video')].some((o) => o !== v && area(o.getBoundingClientRect()) >= 160 * 90);
      if (others) return null;
      const labelled = [...el.querySelectorAll(BUTTONS)].find((b) => b.id !== 'ytpm-btn' && FULLSCREEN.test(labelOf(b)));
      const fs = labelled || bottomRight(v, el);
      if (fs) return { fs, root: el };
    }
    return null;
  }

  function insertButton(btn) {
    const v = findVideo();
    if (!v || v.ownerDocument !== document) return false;
    // Players without a control bar of their own: look again now and then.
    if (miss.video === v && Date.now() - miss.at < 5000) return false;
    const hit = siteControls(v);
    if (!hit) {
      miss = { video: v, at: Date.now() };
      return false;
    }
    root = hit.root;
    // Next to the fullscreen control's item in the bar, not inside a wrapper.
    let item = hit.fs;
    while (item.parentElement && item.parentElement !== root && item.parentElement.children.length === 1) item = item.parentElement;
    const size = Math.round(hit.fs.getBoundingClientRect().height) || 32;
    btn.style.cssText = `display:inline-flex;align-items:center;justify-content:center;flex:none;align-self:center;` +
      `box-sizing:border-box;width:${size}px;height:${size}px;margin:0;padding:0;border:0;background:transparent;cursor:pointer;`;
    // Players often toggle playback on presses anywhere over the video.
    for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick']) btn.addEventListener(t, (e) => e.stopPropagation());
    item.before(btn);
    return true;
  }

  // Covers the paused Mac player while the TV plays (not in move mode, where
  // the video has left the page and a placeholder stands in).
  function shieldHost() {
    if (!root?.isConnected || !main || !root.contains(main)) return null;
    return getComputedStyle(root).position === 'static' ? null : root;
  }

  return {
    id: 'generic',
    name: 'this site',
    matches: () => true,
    usesBridge: false,
    // In-page navigation on an arbitrary site doesn't reliably mean "a new video".
    followsNavigation: false,
    // Move mode (content/move.js) is offered here only.
    canMove: true,
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
    shieldHost,
    insertButton,

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
