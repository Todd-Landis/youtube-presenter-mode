// Move-video spike: moves this page's <video> elements into a same-origin
// popup and records what happens. Results survive a reload (sessionStorage);
// the popup runs its own status script, so it keeps reporting after this page
// is reloaded or closed.
'use strict';
const TV_NAME = 'ytpm-spike-tv';
const MSE_TYPE = 'video/mp4; codecs="avc1.4D001F, mp4a.40.2"';
const KINDS = ['mp4', 'mse'];
const LABEL = { mp4: 'Plain MP4', mse: 'MediaSource' };
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const V = { mp4: $('#v-mp4'), mse: $('#v-mse') };
const R = restore() || { ua: navigator.userAgent, checks: { mp4: {}, mse: {} }, log: [] };
R.loads = (R.loads || 0) + 1;
const homes = {}; // kind -> placeholder left where the video was
const counts = { mp4: {}, mse: {} };
let tv = null;

// ---- bookkeeping -------------------------------------------------------------

function restore() {
  try { return JSON.parse(sessionStorage.getItem('ytpm-spike')); } catch { return null; }
}
function save() {
  try { sessionStorage.setItem('ytpm-spike', JSON.stringify(R)); } catch {}
}
function log(msg, data) {
  const line = new Date().toISOString().slice(11, 23) + '  ' + msg + (data ? '  ' + JSON.stringify(data) : '');
  R.log.push(line);
  if (R.log.length > 300) R.log.shift();
  $('#log').textContent = R.log.slice().reverse().join('\n');
  save();
}
const snap = (v) => v && ({
  t: +v.currentTime.toFixed(2), paused: v.paused, readyState: v.readyState,
  error: v.error ? v.error.code : null, inPopup: v.ownerDocument !== document,
});

for (const kind of KINDS) {
  for (const type of ['play', 'pause', 'waiting', 'stalled', 'error', 'emptied', 'ended']) {
    V[kind].addEventListener(type, () => {
      counts[kind][type] = (counts[kind][type] || 0) + 1;
      if (type !== 'play' && type !== 'pause') log(`${kind}: ${type}`, snap(V[kind]));
    });
  }
}

// A frame drawn to a tiny canvas: a black or missing picture has no variance.
function picture(v) {
  try {
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 18;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, 32, 18);
    const d = ctx.getImageData(0, 0, 32, 18).data;
    let sum = 0, sum2 = 0;
    for (let i = 0; i < d.length; i += 4) {
      const y = (d[i] + d[i + 1] + d[i + 2]) / 3;
      sum += y;
      sum2 += y * y;
    }
    const n = d.length / 4, mean = sum / n;
    return { ok: mean > 12 && sum2 / n - mean * mean > 30, mean: Math.round(mean) };
  } catch (e) {
    return { ok: false, error: e.name };
  }
}

// ---- MediaSource feeder ---------------------------------------------------------
// Like a real player: small range requests on a timer, keeping ~6 s buffered.
// It runs on this page's timers, so it shows what throttling does to it.

const feed = { ticks: 0, lastAt: 0, maxGapMs: 0, appended: 0, size: 0, done: false };

function startMse(v) {
  const MS = window.MediaSource || window.ManagedMediaSource;
  R.mseApi = window.MediaSource ? 'MediaSource' : window.ManagedMediaSource ? 'ManagedMediaSource' : 'none';
  if (!MS) return log('no MediaSource API in this browser');
  R.mseTypeSupported = MS.isTypeSupported(MSE_TYPE);
  const ms = new MS();
  if (MS !== window.MediaSource) v.disableRemotePlayback = true; // ManagedMediaSource requires it
  v.src = URL.createObjectURL(ms);
  ms.addEventListener('sourceopen', async () => {
    const sb = ms.addSourceBuffer(MSE_TYPE);
    feed.size = Number((await fetch('media/clip-frag.mp4', { method: 'HEAD' })).headers.get('Content-Length'));
    const tick = async () => {
      const now = performance.now();
      if (feed.lastAt) {
        const gap = now - feed.lastAt;
        feed.maxGapMs = Math.max(feed.maxGapMs, gap);
        if (R.hidden && !R.hidden.back) {
          R.hidden.feedTicks++;
          R.hidden.feedMaxGapMs = Math.max(R.hidden.feedMaxGapMs, Math.round(gap));
        }
      }
      feed.lastAt = now;
      feed.ticks++;
      try {
        if (!feed.done && !sb.updating && ahead(v) < 6) {
          const end = Math.min(feed.size, feed.appended + 64 * 1024) - 1;
          const buf = await (await fetch('media/clip-frag.mp4', { headers: { Range: `bytes=${feed.appended}-${end}` } })).arrayBuffer();
          sb.appendBuffer(buf);
          await new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
          feed.appended = end + 1;
          if (feed.appended >= feed.size) {
            feed.done = true;
            if (ms.readyState === 'open') ms.endOfStream();
          }
        }
      } catch (e) {
        log('MediaSource feeder error', { error: String(e), mediaSource: ms.readyState });
        // The MediaSource was detached (the element was reset or errored):
        // nothing more can be appended, so stop instead of repeating the error.
        if (ms.readyState !== 'open') return void (feed.stopped = String(e));
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

function ahead(v) {
  const b = v.buffered;
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) <= v.currentTime + 0.2 && b.end(i) >= v.currentTime) return b.end(i) - v.currentTime;
  }
  return 0;
}

// ---- the popup ("TV") ----------------------------------------------------------------

const TV_CSS = `
html, body { margin: 0; height: 100%; background: #000; color: #fff; overflow: hidden;
  font: 13px -apple-system, BlinkMacSystemFont, sans-serif; }
#tv { display: grid; grid-template-rows: 1fr 1fr; gap: 2px; height: 100%; }
.slot { position: relative; min-height: 0; background: #111; }
.slot > .label { position: absolute; top: 6px; left: 8px; opacity: .5; }
.slot video { position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important;
  object-fit: contain !important; background: #000; }
#hud { position: fixed; right: 8px; bottom: 8px; z-index: 2; background: rgba(0,0,0,.78); border-radius: 8px;
  padding: 8px 10px; font: 12px/1.45 ui-monospace, Menlo, monospace; white-space: pre; }
#hud button { margin-top: 6px; font: inherit; border: 0; border-radius: 6px; padding: 3px 10px; cursor: pointer; }
`;

// Must run inside a click: window.open needs one unless pop-ups are allowed.
function openTv() {
  if (tv && !tv.closed) return tv;
  const left = (screen.availLeft || 0) + 80, top = (screen.availTop || 0) + 80;
  tv = window.open('', TV_NAME, `popup,width=960,height=620,left=${left},top=${top}`);
  if (!tv) {
    log('window.open returned null (pop-up blocked)');
    return null;
  }
  setupTv(tv);
  return tv;
}

function setupTv(w) {
  const d = w.document;
  if (d.getElementById('tv')) return;
  d.title = 'Spike TV';
  const style = d.createElement('style');
  style.textContent = TV_CSS;
  (d.head || d.documentElement).append(style);
  const root = d.createElement('div');
  root.id = 'tv';
  for (const kind of KINDS) {
    const slot = d.createElement('div');
    slot.className = 'slot';
    slot.dataset.kind = kind;
    const label = d.createElement('div');
    label.className = 'label';
    label.textContent = LABEL[kind];
    slot.append(label);
    root.append(slot);
  }
  const hud = d.createElement('div');
  hud.id = 'hud';
  const text = d.createElement('div');
  text.id = 'hud-text';
  const copy = d.createElement('button');
  copy.id = 'hud-copy';
  copy.textContent = 'Copy';
  hud.append(text, copy);
  d.body.append(root, hud);
  // The status panel runs in the popup's own JS realm, so it outlives this page.
  const s = d.createElement('script');
  s.textContent = '(' + tvMain.toString() + ')();';
  d.body.append(s);
}

// Runs inside the popup.
function tvMain() {
  const hud = { since: Date.now(), opener: 'open', videos: {}, events: [] };
  window.__hud = hud;
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 18;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const watched = new WeakSet();
  const picture = (v) => {
    try {
      ctx.drawImage(v, 0, 0, 32, 18);
      const d = ctx.getImageData(0, 0, 32, 18).data;
      let sum = 0, sum2 = 0;
      for (let i = 0; i < d.length; i += 4) {
        const y = (d[i] + d[i + 1] + d[i + 2]) / 3;
        sum += y;
        sum2 += y * y;
      }
      const n = d.length / 4, mean = sum / n;
      return mean > 12 && sum2 / n - mean * mean > 30;
    } catch (e) {
      return e.name;
    }
  };
  setInterval(() => {
    let opener = 'gone';
    try { opener = !window.opener ? 'gone' : window.opener.closed ? 'closed' : 'open'; } catch { opener = 'inaccessible'; }
    if (opener !== hud.opener) hud.events.push({ at: Date.now(), type: 'opener ' + opener });
    hud.opener = opener;
    const now = Date.now();
    for (const v of document.querySelectorAll('video')) {
      const kind = v.dataset.kind;
      if (!watched.has(v)) {
        watched.add(v);
        for (const type of ['play', 'pause', 'waiting', 'stalled', 'playing', 'error', 'emptied', 'ended']) {
          v.addEventListener(type, () => {
            hud.events.push({ at: Date.now(), kind, type, t: +v.currentTime.toFixed(1) });
            if (hud.events.length > 300) hud.events.shift();
          });
        }
      }
      const prev = hud.videos[kind] || {};
      const advancing = prev.t != null && v.currentTime > prev.t + 0.05;
      hud.videos[kind] = {
        t: +v.currentTime.toFixed(2), paused: v.paused, advancing, readyState: v.readyState,
        error: v.error ? v.error.code : null, picture: picture(v),
        stuckSince: !v.paused && !advancing ? prev.stuckSince || now : null,
      };
    }
    const lines = ['opener page: ' + hud.opener];
    for (const [kind, s] of Object.entries(hud.videos)) {
      const state = s.error ? 'ERROR ' + s.error : s.paused ? 'paused' : s.advancing ? 'playing' : 'STUCK ' + Math.round((now - s.stuckSince) / 1000) + ' s';
      lines.push(`${kind.padEnd(4)} ${state.padEnd(11)} t=${s.t.toFixed(1)} ready=${s.readyState} picture=${s.picture === true ? 'yes' : s.picture}`);
    }
    document.getElementById('hud-text').textContent = lines.join('\n');
  }, 500);
  document.getElementById('hud-copy').addEventListener('click', (e) => {
    navigator.clipboard.writeText(JSON.stringify(hud, null, 2)).then(() => { e.target.textContent = 'Copied'; });
  });
}

function moveToTv(kind) {
  const w = openTv();
  if (!w) return false;
  const v = V[kind];
  if (v.ownerDocument === w.document) return true;
  const ph = document.createElement('div');
  ph.className = 'placeholder';
  ph.textContent = 'Playing in the popup';
  v.before(ph);
  homes[kind] = ph;
  v.dataset.kind = kind;
  // One DOM operation: the element is adopted into the popup's document and
  // never sits outside a document, so nothing in the spec pauses it.
  w.document.querySelector(`.slot[data-kind="${kind}"]`).append(v);
  log(`${kind}: moved to the popup`, snap(v));
  return true;
}

function moveBack(kind) {
  const v = V[kind];
  if (!homes[kind] || v.ownerDocument === document) return;
  homes[kind].replaceWith(v);
  delete homes[kind];
  log(`${kind}: moved back`, snap(v));
}

// ---- automatic checks ---------------------------------------------------------------

const playingSince = (v, t0, at0) => !v.paused && v.currentTime - t0 > ((performance.now() - at0) / 1000) * 0.6;

async function until(cond, ms) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(100);
  return cond();
}

async function run() {
  $('#run').disabled = true;
  R.checks = { mp4: {}, mse: {} };
  // Still inside the click: open the popup and start both videos with sound.
  const w = openTv();
  R.popupOpened = !!w;
  if (!w) return finish('The browser blocked the popup. Allow pop-ups for localhost, or click again.');
  for (const kind of KINDS) {
    V[kind].muted = false;
    V[kind].play().catch((e) => log(`${kind}: play() refused`, { name: e.name }));
  }
  if (!(await until(() => KINDS.every((k) => !V[k].paused && V[k].currentTime > 1), 10000))) {
    log('videos did not start', { mp4: snap(V.mp4), mse: snap(V.mse) });
  }
  for (const kind of KINDS) {
    const v = V[kind], c = R.checks[kind];
    status(`Checking ${LABEL[kind]}…`);
    const pauses = counts[kind].pause || 0, empties = counts[kind].emptied || 0;
    let t0 = v.currentTime, at0 = performance.now();
    moveToTv(kind);
    c.pausedRightAfterMove = v.paused;
    await sleep(2500);
    c.keptPlaying = playingSince(v, t0, at0);
    c.pauseEvents = (counts[kind].pause || 0) - pauses;
    // Chromium re-runs the load algorithm on adoption: the element empties and
    // starts over (or errors, for MediaSource).
    c.resetByMove = (counts[kind].emptied || 0) > empties || v.currentTime < t0 - 1 || !!v.error;
    c.errorAfterMove = v.error ? v.error.code : null;
    c.picture = picture(v).ok;
    if (v.paused) {
      try { await v.play(); c.resumedByPlay = true; } catch (e) { c.resumedByPlay = e.name; }
      await sleep(1000);
    }
    // Control from this page, without a click (as the extension does).
    v.pause();
    await sleep(400);
    c.pauseFromPage = v.paused;
    try {
      await v.play();
      await sleep(800);
      c.playFromPage = !v.paused;
    } catch (e) {
      c.playFromPage = 'refused: ' + e.name;
    }
    const t1 = v.currentTime;
    v.currentTime = t1 + 10;
    await sleep(1000);
    c.seekFromPage = v.currentTime > t1 + 9;
    v.volume = 0.5;
    c.volumeFromPage = Math.abs(v.volume - 0.5) < 0.01;
    v.volume = 1;
    t0 = v.currentTime;
    at0 = performance.now();
    moveBack(kind);
    await sleep(2000);
    c.keptPlayingAfterMoveBack = playingSince(v, t0, at0);
    t0 = v.currentTime;
    at0 = performance.now();
    moveToTv(kind);
    await sleep(2000);
    c.keptPlayingAfterSecondMove = playingSince(v, t0, at0);
    c.pictureAfterSecondMove = picture(v).ok;
    log(`${kind}: checks done`, c);
    render();
  }
  finish('Done. Both videos are left playing in the popup for the manual checks.');
}

function finish(msg) {
  status(msg);
  $('#run').disabled = false;
  save();
  render();
}

function status(msg) {
  $('#runStatus').textContent = msg;
}

// ---- hidden, reload, reconnect ------------------------------------------------------------

function tvVideo(kind) {
  if (V[kind].ownerDocument !== document) return V[kind];
  return tv && !tv.closed ? tv.document.querySelector(`video[data-kind="${kind}"]`) : null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    const t = {};
    for (const kind of KINDS) t[kind] = tvVideo(kind)?.currentTime ?? null;
    // Only interesting while a video is in the popup.
    if (KINDS.some((k) => t[k] != null)) R.hidden = { at: Date.now(), t, feedTicks: 0, feedMaxGapMs: 0 };
    save();
    return;
  }
  const h = R.hidden;
  if (!h || h.back) return;
  h.back = Date.now();
  h.seconds = Math.round((h.back - h.at) / 1000);
  h.videos = {};
  for (const kind of KINDS) {
    const v = tvVideo(kind);
    if (!v || h.t[kind] == null) continue;
    const events = (tv.__hud?.events || []).filter((e) => e.kind === kind && e.at >= h.at && /waiting|stalled|pause|error/.test(e.type));
    h.videos[kind] = { advancedSec: +(v.currentTime - h.t[kind]).toFixed(1), paused: v.paused, events: events.map((e) => e.type) };
  }
  log('back from hidden', h);
  render();
});

addEventListener('pagehide', () => {
  const t = {};
  for (const kind of KINDS) t[kind] = tvVideo(kind)?.currentTime ?? null;
  if (KINDS.some((k) => t[k] != null)) R.reload = { at: Date.now(), t };
  else delete R.reload;
  save();
});

// After a reload: find the popup again by name. Safari's pop-up blocker lets
// window.open reach an existing named window without a click; if it isn't
// there and pop-ups are allowed, this opens an empty one, which is closed.
async function reconnect(viaClick) {
  if (!R.reload?.t) return;
  let w = null;
  try { w = window.open('', TV_NAME); } catch (e) { log('window.open threw', { name: e.name }); }
  const r = R.reload;
  if (!w) {
    r.reconnect = viaClick ? 'blocked even with a click' : 'blocked without a click';
  } else if (!w.document.getElementById('tv')) {
    r.reconnect = 'no popup found (opened an empty window, closed it)';
    w.close();
  } else {
    tv = w;
    r.reconnect = viaClick ? 'found (with a click)' : 'found without a click';
    await sleep(1500);
    r.seconds = Math.round((Date.now() - r.at) / 1000);
    r.videos = {};
    for (const kind of KINDS) {
      const v = tv.document.querySelector(`video[data-kind="${kind}"]`);
      if (!v || r.t[kind] == null) continue;
      const elapsed = (Date.now() - r.at) / 1000;
      r.videos[kind] = {
        keptPlaying: !v.paused && v.currentTime - r.t[kind] > elapsed * 0.6,
        advancedSec: +(v.currentTime - r.t[kind]).toFixed(1), elapsedSec: +elapsed.toFixed(1),
        paused: v.paused, readyState: v.readyState, error: v.error ? v.error.code : null,
        picture: tv.__hud?.videos?.[kind]?.picture ?? null,
      };
    }
  }
  log('after reload', r);
  render();
}

// ---- rendering --------------------------------------------------------------------------------

const ROWS = [
  ['Kept playing when moved into the popup', (k) => R.checks[k]?.keptPlaying],
  ['Reset by the move (emptied, restarted or errored)', (k) => R.checks[k]?.resetByMove, true],
  ['Media error after the move', (k) => R.checks[k] && (R.checks[k].errorAfterMove ?? 'none')],
  ['Paused at the moment of the move', (k) => R.checks[k]?.pausedRightAfterMove, true],
  ['Pause events during the move', (k) => R.checks[k]?.pauseEvents],
  ['Picture in the popup', (k) => R.checks[k]?.picture],
  ['Pause from this page', (k) => R.checks[k]?.pauseFromPage],
  ['Play with sound from this page (no click)', (k) => R.checks[k]?.playFromPage],
  ['Seek from this page', (k) => R.checks[k]?.seekFromPage],
  ['Volume from this page', (k) => R.checks[k]?.volumeFromPage],
  ['Kept playing when moved back', (k) => R.checks[k]?.keptPlayingAfterMoveBack],
  ['Kept playing when moved in again', (k) => R.checks[k]?.keptPlayingAfterSecondMove],
  ['While this page was hidden: seconds advanced', (k) => R.hidden?.videos?.[k] && `${R.hidden.videos[k].advancedSec} of ${R.hidden.seconds}`],
  ['While this page was hidden: stalls and pauses', (k) => R.hidden?.videos?.[k] && (R.hidden.videos[k].events.join(', ') || 'none')],
  ['While this page was hidden: its timers (ticks, longest gap)', () => R.hidden?.back && `${R.hidden.feedTicks} ticks, ${R.hidden.feedMaxGapMs} ms`],
  ['Reload: popup found again', () => R.reload?.reconnect],
  ['Reload: kept playing through it', (k) => R.reload?.videos?.[k] && `${R.reload.videos[k].keptPlaying} (${R.reload.videos[k].advancedSec} of ${R.reload.videos[k].elapsedSec} s${R.reload.videos[k].error ? ', error ' + R.reload.videos[k].error : ''})`],
];

function render() {
  const body = $('#results tbody');
  body.replaceChildren();
  for (const [label, get, invert] of ROWS) {
    const tr = document.createElement('tr');
    const th = document.createElement('td');
    th.textContent = label;
    tr.append(th);
    for (const kind of KINDS) {
      const v = get(kind);
      const td = document.createElement('td');
      td.textContent = v == null ? '—' : String(v);
      if (typeof v === 'boolean') td.className = v !== !!invert ? 'ok' : 'bad';
      tr.append(td);
    }
    body.append(tr);
  }
}

setInterval(() => {
  for (const kind of KINDS) {
    const v = tvVideo(kind) || V[kind];
    const s = snap(v);
    let line = `t ${s.t.toFixed(1)} · ${s.paused ? 'paused' : 'playing'} · ready ${s.readyState} · ${s.inPopup ? 'in the popup' : 'in this page'}`;
    if (s.error) line += ` · error ${s.error}`;
    if (kind === 'mse') line += `\nbuffered ahead ${ahead(V.mse).toFixed(1)} s · feeder ${feed.stopped ? 'stopped' : feed.ticks + ' ticks'}, longest gap ${Math.round(feed.maxGapMs)} ms`;
    $('#s-' + kind).textContent = line;
  }
}, 500);

// ---- wiring -------------------------------------------------------------------------------------

$('#run').addEventListener('click', run);
$('#reconnect').addEventListener('click', () => (R.reload?.t ? reconnect(true) : status('Nothing to reconnect to: reload this page with videos in the popup first.')));
$('#copy').addEventListener('click', () => {
  const out = { ...R, hud: tv && !tv.closed ? tv.__hud : null };
  navigator.clipboard.writeText(JSON.stringify(out, null, 2)).then(() => status('Results copied.'));
});
for (const row of document.querySelectorAll('.buttons')) {
  const kind = row.dataset.kind;
  row.addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    const v = tvVideo(kind) || V[kind];
    if (act === 'move') moveToTv(kind);
    if (act === 'back') moveBack(kind);
    if (act === 'toggle') v.paused ? v.play().catch((err) => log(`${kind}: play() refused`, { name: err.name })) : v.pause();
    if (act === 'rew') v.currentTime = Math.max(0, v.currentTime - 10);
    if (act === 'ff') v.currentTime += 10;
  });
}

startMse(V.mse);
render();
$('#log').textContent = R.log.slice().reverse().join('\n');
if (R.reload?.t && !R.reload.reconnect) reconnect(false);
log('page loaded', { load: R.loads, mse: R.mseApi, typeSupported: R.mseTypeSupported });
