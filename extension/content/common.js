// Shared helpers for the isolated-world content scripts. Loaded first; the
// other content scripts hang their modules off the same YTPM namespace.
'use strict';
var YTPM = globalThis.YTPM || (globalThis.YTPM = {});

(() => {
  const ext = globalThis.browser ?? globalThis.chrome;
  YTPM.ext = ext;
  YTPM.PLAYER_HASH = 'ytpm-player';

  YTPM.debug = (...args) => console.debug('[YTPM]', ...args);
  YTPM.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  YTPM.clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  YTPM.send = async (msg) => {
    try {
      return await ext.runtime.sendMessage(msg);
    } catch (e) {
      YTPM.debug('sendMessage failed', msg.type, e?.message);
      return null;
    }
  };

  // DOM builder. YouTube enforces Trusted Types, so we never touch innerHTML.
  YTPM.h = (tag, props, ...kids) => {
    const svg = tag.startsWith('svg:');
    const el = svg
      ? document.createElementNS('http://www.w3.org/2000/svg', tag.slice(4))
      : document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'textContent') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : String(kid));
    }
    return el;
  };

  YTPM.ICONS = {
    play: 'M8 5v14l11-7z',
    pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
    vol: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    mute: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
    cc: 'M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z',
    fullscreen: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
    present: 'M21 3H3c-1.11 0-2 .89-2 2v14c0 1.11.89 2 2 2h18c1.11 0 2-.89 2-2V5c0-1.11-.89-2-2-2zm0 16.02H3V4.98h18v14.04zM10 12H8l4-4 4 4h-2v4h-4v-4z',
    tv: 'M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z',
    airplay: 'M6 22h12l-6-6zM21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h4v-2H3V5h18v12h-4v2h4c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z',
    collapse: 'M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z',
    expand: 'M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z',
  };

  YTPM.icon = (name, size = 20) =>
    YTPM.h('svg:svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', fill: 'currentColor' },
      YTPM.h('svg:path', { d: YTPM.ICONS[name] }));

  YTPM.fmtTime = (s) => {
    if (!Number.isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
  };

  YTPM.parseWatch = (href) => {
    try {
      const u = new URL(href);
      if (u.pathname !== '/watch') return { videoId: null };
      const q = u.searchParams;
      return { videoId: q.get('v'), list: q.get('list'), index: q.get('index') };
    } catch {
      return { videoId: null };
    }
  };

  YTPM.findVideo = () =>
    document.querySelector('#movie_player video.html5-main-video') ||
    document.querySelector('#movie_player video');

  // What this window can tell about the display it is on. Safari exposes the
  // non-standard availLeft/availTop, which identify the screen's origin.
  YTPM.screenInfo = () => ({
    sx: window.screenX, sy: window.screenY,
    sw: screen.width, sh: screen.height,
    al: screen.availLeft ?? null, at: screen.availTop ?? null,
    aw: screen.availWidth, ah: screen.availHeight,
    iw: window.innerWidth, ih: window.innerHeight,
    ow: window.outerWidth, oh: window.outerHeight,
    dpr: window.devicePixelRatio,
  });

  YTPM.sameScreen = (a, b) =>
    !!a && !!b && a.sw === b.sw && a.sh === b.sh && a.al === b.al && a.at === b.at;

  YTPM.fillsScreen = (s) => !!s && s.iw >= s.sw - 2 && s.ih >= s.sh - 2;

  // ---- Page-world bridge client -------------------------------------------
  // YouTube's player API (#movie_player.seekTo etc.) only exists in the page's
  // JS world. page-bridge.js runs there and answers window.postMessage calls.
  const pending = new Map();
  let callSeq = 0;
  window.addEventListener('message', (e) => {
    const m = e.data;
    // No e.source check: across worlds it is not reliably `window` in Safari.
    if (!m || m.__ytpm !== 'from-page') return;
    const done = pending.get(m.id);
    if (done) {
      pending.delete(m.id);
      done(m);
    }
  });

  YTPM.bridge = {
    ready: false,
    info: null,
    call(op, args, timeout = 1500) {
      return new Promise((resolve, reject) => {
        const id = 'c' + ++callSeq + '-' + Math.random().toString(36).slice(2, 6);
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('bridge timeout: ' + op));
        }, timeout);
        pending.set(id, (m) => {
          clearTimeout(timer);
          m.error ? reject(new Error(m.error)) : resolve(m.result);
        });
        window.postMessage({ __ytpm: 'to-page', id, op, args }, location.origin);
      });
    },
  };

  // Resolves to bridge info, or {mainWorld:false} if no page-world script answers.
  // Safari ignores `world: "MAIN"` in the manifest, so the bridge usually
  // arrives by one of the fallbacks. Each failure is kept for diagnostics.
  YTPM.initBridge = async () => {
    const hello = () => YTPM.bridge.call('hello', null, 700).catch(() => null);
    const errors = [];
    const attempts = [
      ['manifest', () => {}],
      ['script-tag', () => {
        // YouTube enforces Trusted Types; a policy keeps the src assignment legal.
        let url = ext.runtime.getURL('content/page-bridge.js');
        try {
          url = trustedTypes.createPolicy('ytpm-bridge', { createScriptURL: (u) => u }).createScriptURL(url);
        } catch {}
        const s = document.createElement('script');
        s.src = url;
        s.onload = () => s.remove();
        (document.head || document.documentElement).append(s);
      }],
      ['scripting', async () => {
        const r = await YTPM.send({ type: 'injectBridge' });
        if (!r?.ok) throw new Error(r?.error || 'no response');
      }],
    ];
    let info = null;
    for (const [via, inject] of attempts) {
      try {
        await inject();
        if (via !== 'manifest') await YTPM.sleep(300);
        info = await hello();
      } catch (e) {
        errors.push(via + ': ' + (e?.message || e));
      }
      if (info) {
        info.via = via;
        break;
      }
    }
    YTPM.bridge.info = info ? { ...info, errors } : { mainWorld: false, errors };
    YTPM.bridge.ready = !!info?.mainWorld;
    return YTPM.bridge.info;
  };
})();
