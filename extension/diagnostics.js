'use strict';
const ext = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
let latest = null;

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : String(k));
  return e;
}

const fmt = (v) => (v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const time = (ts) => (ts ? new Date(ts).toLocaleTimeString() : '—');
const code = (v) => el('code', {}, fmt(v));

function kv(rows) {
  return el('table', {}, el('tbody', {}, rows.filter(Boolean).map(([k, v]) =>
    el('tr', {}, el('th', {}, k), el('td', {}, v && v.nodeType ? v : code(v))))));
}

function grid(cols, rows) {
  if (!rows.length) return el('p', { class: 'note' }, 'Nothing recorded yet.');
  return el('div', { class: 'scroll' }, el('table', {},
    el('thead', {}, el('tr', {}, cols.map((c) => el('th', {}, c[0])))),
    el('tbody', {}, rows.map((r) => el('tr', {}, cols.map((c) => el('td', {}, fmt(c[1](r)))))))));
}

function verdict(id, kind, text) {
  $(id).replaceChildren(el('span', { class: 'verdict v-' + kind }, text));
}

function render(r) {
  latest = r;
  const { diag: D, session: S, lastState: L, settings, tvBounds } = r;

  $('session').replaceChildren(kv([
    ['Active', S ? `yes, ${S.mode} mode, started ${time(S.startedAt)}` : 'no'],
    ['Settings', settings],
    ['Remembered TV window spot', tvBounds],
    ['Player state (latest)', L ? `${L.paused ? 'paused' : 'playing'} at ${L.t?.toFixed(1)}s of ${L.d?.toFixed(0)}s, rate ${L.rate}, ${L.vis}${L.focus ? ', focused' : ''}${L.fs ? ', element fullscreen' : ''}` : null],
    ['User agent', D.env?.userAgent],
  ]));

  // Window placement
  const s1 = D.placement || {};
  const fs = s1.windowFullscreen;
  if (s1.mode === 'airplay') verdict('v1', 'none', 'n/a in AirPlay mode');
  else if (s1.playerOnOtherScreen == null) verdict('v1', 'none', 'not run');
  else if (s1.playerOnOtherScreen && fs?.playerFillsScreenAfter) verdict('v1', 'ok', 'placed and fullscreen, no click');
  else if (s1.playerOnOtherScreen) verdict('v1', 'warn', 'placed; fullscreen needs a click');
  else verdict('v1', 'bad', 'window did not land on the TV');
  $('s1').replaceChildren(kv([
    ['Requested bounds', s1.requested],
    ['Used remembered spot', s1.rememberedBoundsUsed],
    ['windows.create errors', s1.createErrors?.length ? s1.createErrors : 'none'],
    ['Created window (as reported)', s1.created],
    ['Window 1.5 s later', s1.after1500ms],
    ['Controller screen', s1.controllerScreen],
    ['Player screen (latest)', s1.playerScreen],
    ['Player on another screen', s1.playerOnOtherScreen],
    ['Window fullscreen attempt', fs],
  ]));

  // Background playback
  const s2 = D.playback || {};
  const mins = (s2.playingSec || 0) / 60;
  if (mins < 1) verdict('v2', 'none', 'not enough playback yet');
  else if (!s2.gaps.length && !s2.stalls.length) verdict('v2', 'ok', `clean over ${mins.toFixed(1)} min`);
  else if (!s2.stalls.length) verdict('v2', 'warn', `${s2.gaps.length} sync gaps, no stalls`);
  else verdict('v2', 'bad', `${s2.stalls.length} playback stalls`);
  $('s2').replaceChildren(
    kv([
      ['Playback observed', `${mins.toFixed(1)} min`],
      ['State messages', s2.msgs],
      ['Longest gap between messages', `${s2.maxGapMs} ms`],
      ['Longest timer gap in player (500 ms expected)', `${s2.maxTickGapMs} ms`],
      ['Dropped video frames', s2.droppedFrames],
    ]),
    el('h3', { style: 'font-size:13px;margin:12px 0 4px' }, 'Gaps'),
    grid([['When', (g) => time(g.at)], ['Gap ms', (g) => g.gapMs], ['Visibility', (g) => g.vis], ['Focused', (g) => g.focus], ['Paused', (g) => g.paused]], s2.gaps.slice().reverse()),
    el('h3', { style: 'font-size:13px;margin:12px 0 4px' }, 'Stalls'),
    grid([['When', (g) => time(g.at)], ['Wall s', (g) => g.wallSec], ['Media s', (g) => g.mediaSec], ['Visibility', (g) => g.vis], ['Focused', (g) => g.focus], ['AirPlay', (g) => g.wireless]], s2.stalls.slice().reverse()),
    el('h3', { style: 'font-size:13px;margin:12px 0 4px' }, 'Visibility changes'),
    grid([['When', (g) => time(g.at)], ['Visibility', (g) => g.vis], ['Focused', (g) => g.focus]], s2.visibility.slice().reverse()),
  );

  // Command delivery
  const c = D.commands || { direct: 0, retried: 0, queued: 0, expired: 0, failures: [] };
  const total = c.direct + c.retried + c.queued;
  if (!total) verdict('vc', 'none', 'no commands yet');
  else if (c.expired) verdict('vc', 'bad', `${c.expired} commands lost`);
  else if (c.queued || c.retried) verdict('vc', 'warn', `${c.retried + c.queued} of ${total} needed a fallback`);
  else verdict('vc', 'ok', `all ${total} delivered directly`);
  $('sc').replaceChildren(
    kv([
      ['Delivered directly', c.direct],
      ['Delivered on retry', c.retried],
      ['Queued for the player to collect', c.queued],
      ['Expired in the queue', c.expired],
    ]),
    el('h3', { style: 'font-size:13px;margin:12px 0 4px' }, 'Direct delivery failures'),
    grid([['When', (x) => time(x.at)], ['Command', (x) => x.action], ['Safari error', (x) => x.error], ['Retry error', (x) => x.retryError],
      ['ms since player report', (x) => x.msSincePlayerState], ['Player visibility', (x) => x.playerVis]], c.failures.slice().reverse()),
  );

  // Control paths
  const s3 = D.controls || {};
  const results = s3.selftest?.results || [];
  const works = (test) => results.filter((x) => x.test === test && x.works).map((x) => x.method);
  if (!results.length) verdict('v3', 'none', s3.bridge ? `bridge: ${s3.bridge.mainWorld ? 'page world OK' : 'unavailable'}` : 'not run');
  else verdict('v3', works('captions').length && works('speed').length ? 'ok' : 'warn',
    `captions via ${works('captions').join(', ') || 'nothing'}; speed via ${works('speed').join(', ') || 'nothing'}`);
  $('s3').replaceChildren(
    kv([['Page-world bridge', s3.bridge], ['Last self-test', s3.selftest ? time(s3.selftest.at) : null]]),
    el('div', { style: 'height:8px' }),
    grid([['Control', (x) => x.test], ['Method', (x) => x.method], ['Before', (x) => x.before], ['After', (x) => x.after], ['Works', (x) => x.works], ['Note', (x) => x.note]], results),
  );

  // AirPlay
  const a = D.airplay || {};
  if (!a.events?.length) verdict('va', 'none', 'not run');
  else verdict('va', a.drops ? 'warn' : a.connects ? 'ok' : 'none', `${a.connects} connects, ${a.drops} drops`);
  $('sa').replaceChildren(grid([['When', (x) => time(x.at)], ['Event', (x) => x.name], ['Details', (x) => x.data]], (a.events || []).slice().reverse()));

  $('log').replaceChildren(grid([['When', (x) => time(x.at)], ['From', (x) => x.src], ['Event', (x) => x.msg], ['Data', (x) => x.data]], (D.log || []).slice(-80).reverse()));
}

async function refresh() {
  try {
    render(await ext.runtime.sendMessage({ type: 'diag:get' }));
  } catch (e) {
    flash('Could not reach the extension: ' + e.message);
  }
}

function flash(text) {
  $('flash').textContent = text;
  setTimeout(() => { if ($('flash').textContent === text) $('flash').textContent = ''; }, 5000);
}

$('selftest').addEventListener('click', async () => {
  flash('Running self-test in the player window…');
  const r = await ext.runtime.sendMessage({ type: 'diag:selftest' });
  flash(r?.ok === false ? r.error : 'Self-test finished.');
  refresh();
});
$('reset').addEventListener('click', async () => {
  await ext.runtime.sendMessage({ type: 'diag:reset' });
  refresh();
});
$('forget').addEventListener('click', async () => {
  await ext.runtime.sendMessage({ type: 'diag:forgetTv' });
  flash('TV window position forgotten.');
  refresh();
});
$('copy').addEventListener('click', async () => {
  const text = JSON.stringify({ ...latest, copiedAt: new Date().toISOString() }, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    flash('Report copied to the clipboard.');
  } catch {
    const ta = el('textarea', { style: 'width:100%;height:200px' });
    ta.value = text;
    document.querySelector('main').prepend(ta);
    ta.select();
    flash('Clipboard blocked. Select the text box contents and copy.');
  }
});

refresh();
setInterval(refresh, 1500);
