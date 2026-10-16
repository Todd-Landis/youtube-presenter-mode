// Smoke-tests the content scripts in jsdom with a stubbed YouTube DOM and extension runtime.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = fileURLToPath(new URL('../extension/', import.meta.url));
const files = ['content/page-bridge.js', 'content/common.js', 'content/sites/youtube.js', 'content/sites/twitch.js',
  'content/sites/generic.js', 'content/player.js', 'content/move.js', 'content/controller.js', 'content/boot.js'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HTML = `<!doctype html><html><head><title>Test Video - YouTube</title></head><body>
<input id="search" type="text">
<div id="movie_player"><div class="html5-video-container"><video class="html5-main-video"></video></div>
<div class="ytp-chrome-bottom"><div class="ytp-right-controls">
<div class="ytp-right-controls-left"><button class="ytp-subtitles-button ytp-button" aria-pressed="false"></button></div>
<div class="ytp-right-controls-right"><button class="ytp-size-button ytp-button"></button><button class="ytp-fullscreen-button ytp-button"></button></div>
</div></div></div>
<ytd-watch-metadata><h1>Test Title</h1></ytd-watch-metadata></body></html>`;

function setup(url, hello, onSend) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented/.test(e.message)) errors.push(e.message); });
  const dom = new JSDOM(HTML, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  // Fake <video>
  const v = w.document.querySelector('video');
  const vs = { paused: true, muted: false, volume: 1, currentTime: 0, duration: 600, playbackRate: 1, readyState: 4 };
  for (const k of Object.keys(vs)) {
    Object.defineProperty(v, k, { get: () => vs[k], set: (x) => { vs[k] = x; if (k === 'muted' || k === 'volume') v.dispatchEvent(new w.Event('volumechange')); }, configurable: true });
  }
  v.play = async () => { vs.paused = false; v.dispatchEvent(new w.Event('play')); };
  v.pause = () => { vs.paused = true; v.dispatchEvent(new w.Event('pause')); };
  // Fake player API (page world)
  const mp = w.document.getElementById('movie_player');
  const api = { cc: false, rate: 1, vol: 100, muted: false, calls: [] };
  Object.assign(mp, {
    getPlayerState: () => (vs.paused ? 2 : 1),
    playVideo: () => { api.calls.push(['playVideo']); return v.play(); },
    pauseVideo: () => { api.calls.push(['pauseVideo']); v.pause(); },
    seekTo: (t) => { api.calls.push(['seekTo', t]); vs.currentTime = t; },
    getCurrentTime: () => vs.currentTime, getDuration: () => vs.duration,
    getPlaybackRate: () => api.rate, setPlaybackRate: (r) => { api.calls.push(['setPlaybackRate', r]); api.rate = r; vs.playbackRate = r; },
    getAvailablePlaybackRates: () => [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
    getVolume: () => api.vol, setVolume: (x) => { api.calls.push(['setVolume', x]); api.vol = x; },
    isMuted: () => api.muted, mute: () => { api.muted = true; }, unMute: () => { api.muted = false; },
    isSubtitlesOn: () => api.cc, toggleSubtitles: () => { api.cc = !api.cc; },
    getVideoData: () => ({ title: 'API Title', video_id: 'abc' }), getPlaylistId: () => null,
    loadVideoById: (o) => api.calls.push(['loadVideoById', o]), nextVideo: () => api.calls.push(['nextVideo']),
  });
  Object.defineProperty(w.screen, 'width', { value: 1920 });
  Object.defineProperty(w.screen, 'height', { value: 1080 });
  const sent = [];
  w.browser = { runtime: {
    sendMessage: async (m) => { sent.push(m); return onSend?.(m) ?? (m.type === 'hello' ? hello : { ok: true }); },
    onMessage: { addListener: (fn) => { w.__listener = fn; } },
    getURL: (p) => p,
  } };
  for (const f of files) w.eval(fs.readFileSync(path.join(root, f), 'utf8'));
  const deliver = (msg) => new Promise((res) => w.__listener(msg, {}, res));
  return { w, v, vs, api, sent, deliver, errors };
}

// ---------------- controller ----------------
{
  const session = { id: 's', mode: 'extended', key: 'abc', ctrlScreen: {} };
  const t = setup('https://www.youtube.com/watch?v=abc', { role: null, session: null, settings: {} },
    (m) => (m.type === 'start' ? { ok: true, session } : m.type === 'end' ? { ok: true, final: { t: 123, key: 'abc' } } : null));
  const { w, v, vs, sent, deliver } = t;
  const doc = w.document;
  let youtubeSawKey = 0;
  doc.addEventListener('keydown', () => youtubeSawKey++); // stands in for YouTube's own handler
  await sleep(1300);
  const btn = doc.getElementById('ytpm-btn');
  assert.ok(btn, 'presenter button injected');
  assert.equal(btn.nextElementSibling.className, 'ytp-fullscreen-button ytp-button', 'placed before fullscreen');
  vs.currentTime = 42; vs.paused = false;
  btn.click();
  await sleep(50);
  const start = sent.find((m) => m.type === 'start');
  assert.equal(start.key, 'abc');
  assert.equal(start.site, 'youtube');
  assert.match(start.url, /^https:\/\/www\.youtube\.com\/watch\?v=abc&t=42s$/);
  assert.equal(start.t, 42);
  assert.equal(vs.paused, true, 'local video paused');
  assert.equal(vs.muted, true, 'local video muted');
  const host = doc.getElementById('ytpm-remote-host');
  assert.ok(host, 'remote bar shown');
  assert.ok(doc.getElementById('ytpm-shield'), 'shield over local player');

  // local video tries to play again → held
  await v.play();
  assert.equal(vs.paused, true, 'play guard re-pauses');

  await deliver({ type: 'state', state: { t: 61, d: 600, paused: false, rate: 1.5, vol: 80, muted: false, cc: true, ccAvail: true, title: 'On TV', key: 'abc', overlay: 'gesture', hasNext: true } });
  const sr = host.shadowRoot;
  assert.equal(sr.querySelector('.title').textContent, 'On TV');
  assert.match(sr.querySelector('.time').textContent, /^1:0\d \/ 10:00$/);
  assert.equal(sr.querySelector('select').value, '1.5');
  assert.ok(sr.querySelector('.warn').classList.contains('show'), 'needs-click warning shown');

  const key = (k, extra = {}, target = doc.body) =>
    target.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, composed: true, ...extra }));
  const cmds = () => sent.filter((m) => m.type === 'cmd').map((m) => [m.action, m.value]);
  key('k'); key(' '); key('j'); key('ArrowRight'); key('ArrowUp'); key('m'); key('c'); key('f');
  key('>', { shiftKey: true }); key('<', { shiftKey: true }); key('7'); key('N', { shiftKey: true });
  key('K', { shiftKey: true }); // shift+k: not a YouTube shortcut
  key('k', { metaKey: true }); // cmd+k: browser shortcut, leave alone
  key('j', {}, doc.getElementById('search')); // typing in search box
  // Play/pause keys become explicit commands from the bar's state (playing → pause → play).
  assert.deepEqual(cmds(), [
    ['pause', undefined], ['play', undefined], ['seekBy', -10], ['seekBy', 5], ['volumeBy', 5],
    ['toggleMute', undefined], ['toggleCaptions', undefined], ['toggleFullscreen', undefined],
    ['rateStep', 1], ['rateStep', -1], ['seekPercent', 7], ['next', undefined],
  ]);
  assert.equal(youtubeSawKey, 3, 'YouTube only saw shift+K, cmd+K and the search-box key');

  // remote bar buttons
  sr.querySelectorAll('.row button')[1].click(); // −10
  assert.deepEqual(cmds().at(-1), ['seekBy', -10]);

  // Pause from the bar, then a report taken just before the click arrives:
  // it must not flip the bar back to "playing".
  await deliver({ type: 'state', state: { t: 70, d: 600, paused: false, rate: 1, sentAt: Date.now(), title: 'On TV', key: 'abc' } });
  const playBtn = sr.querySelector('.row button');
  playBtn.click();
  assert.deepEqual(cmds().at(-1), ['pause', undefined]);
  await deliver({ type: 'state', state: { t: 70.4, d: 600, paused: false, rate: 1, sentAt: Date.now() - 200, title: 'On TV', key: 'abc' } });
  assert.equal(playBtn.getAttribute('title'), 'Play/pause (k)');
  assert.equal(playBtn.querySelector('path').getAttribute('d'), 'M8 5v14l11-7z', 'still shows the play icon (paused)');
  playBtn.click();
  assert.deepEqual(cmds().at(-1), ['play', undefined], 'second click plays, not a second pause');
  await deliver({ type: 'state', state: { t: 71, d: 600, paused: false, rate: 1, sentAt: Date.now() + 1, title: 'On TV', key: 'abc' } });

  // SPA navigation to another video → loads on the TV
  w.history.pushState({}, '', '/watch?v=zzz');
  doc.dispatchEvent(new w.Event('yt-navigate-finish'));
  assert.equal(JSON.stringify(cmds().at(-1)), JSON.stringify(['load', { key: 'zzz', url: 'https://www.youtube.com/watch?v=zzz', t: 0, list: null, index: null }]));
  w.history.pushState({}, '', '/watch?v=abc');
  doc.dispatchEvent(new w.Event('yt-navigate-finish'));

  // end
  sr.querySelector('button.end').click();
  await sleep(50);
  assert.ok(!doc.getElementById('ytpm-remote-host'), 'bar removed');
  assert.ok(!doc.getElementById('ytpm-shield'), 'shield removed');
  assert.equal(vs.muted, false, 'mute restored');
  assert.equal(vs.currentTime, 123, 'resumed at TV position');
  youtubeSawKey = 0;
  key('k');
  assert.equal(youtubeSawKey, 1, 'keys go back to YouTube after ending');
  assert.deepEqual(t.errors, []);
  console.log('controller ok');
}

// ---------------- player ----------------
{
  const session = { id: 's', mode: 'extended', key: 'abc', startT: 30, ctrlScreen: { sw: 1800, sh: 1169, al: null, at: null } };
  let queued = [];
  const t = setup('https://www.youtube.com/watch?v=abc&t=30s', { role: 'player', session, settings: {} },
    (m) => (m.type === 'state' ? { ok: true, cmds: queued.splice(0) } : null));
  const { w, vs, api, sent, deliver } = t;
  const doc = w.document;
  await sleep(1600);
  assert.ok(doc.documentElement.classList.contains('ytpm-player'), 'player CSS applied');
  assert.ok(!doc.getElementById('ytpm-btn'), 'no presenter button in the player');
  assert.equal(vs.currentTime, 30, 'seeked to start time');
  assert.equal(vs.paused, false, 'playing');
  const states = sent.filter((m) => m.type === 'state').map((m) => m.state);
  assert.ok(states.length >= 2, 'reporting state');
  const last = states.at(-1);
  assert.equal(last.title, 'API Title');
  assert.equal(last.bridge.mainWorld, true);
  assert.equal(last.bridge.via, 'manifest');
  assert.equal(last.overlay, null);

  const cmd = async (action, value) => (await deliver({ type: 'cmd', action, value })).result;
  assert.equal(await cmd('toggleCaptions'), 'api');
  assert.equal(api.cc, true);
  await cmd('rateStep', 1);
  assert.deepEqual(api.calls.filter((c) => c[0] === 'setPlaybackRate').at(-1), ['setPlaybackRate', 1.25]);
  await cmd('seekBy', 10);
  assert.deepEqual(api.calls.filter((c) => c[0] === 'seekTo').at(-1), ['seekTo', 40]);
  await cmd('seekPercent', 5);
  assert.deepEqual(api.calls.filter((c) => c[0] === 'seekTo').at(-1), ['seekTo', 300]);
  await cmd('volumeBy', -5);
  assert.equal(api.vol, 95);
  await cmd('toggleMute');
  assert.equal(api.muted, true);
  const count = (name) => api.calls.filter((c) => c[0] === name).length;
  const pauses = count('pauseVideo');
  await cmd('pause');
  assert.equal(vs.paused, true);
  assert.equal(count('pauseVideo'), pauses + 1, 'paused through YouTube, not just the <video>');
  const plays = count('playVideo');
  await cmd('play');
  assert.equal(vs.paused, false);
  assert.equal(count('playVideo'), plays + 1, 'YouTube told it is playing');
  // YouTube re-plays the element after a pause it didn't know about → pause holds anyway.
  const realPauseVideo = w.document.getElementById('movie_player').pauseVideo;
  w.document.getElementById('movie_player').pauseVideo = () => { vs.paused = true; setTimeout(() => { vs.paused = false; }, 100); };
  await cmd('pause');
  await sleep(700);
  assert.equal(vs.paused, true, 'pause re-applied after YouTube resumed');
  assert.ok(sent.some((m) => m.type === 'event' && m.name === 'pause-retried'));
  w.document.getElementById('movie_player').pauseVideo = realPauseVideo;
  await cmd('togglePlay');
  assert.equal(vs.paused, false);
  assert.equal(await cmd('load', { key: 'zzz', url: 'https://www.youtube.com/watch?v=zzz', t: 0 }), 'api');

  // Same command id twice (direct retry + queued copy) runs once.
  const before = api.calls.filter((c) => c[0] === 'seekTo').length;
  assert.equal((await deliver({ type: 'cmd', id: 'x1', action: 'seekBy', value: 3 })).ok, true);
  assert.equal((await deliver({ type: 'cmd', id: 'x1', action: 'seekBy', value: 3 })).duplicate, true);
  queued.push({ type: 'cmd', id: 'x1', action: 'seekBy', value: 3 }, { type: 'cmd', id: 'x2', action: 'seekBy', value: 3 });
  await sleep(700); // next state report collects the queue
  assert.equal(api.calls.filter((c) => c[0] === 'seekTo').length, before + 2, 'x1 once, then queued x2');

  // Fullscreen toggle tells the background which way to go.
  await cmd('toggleFullscreen');
  const fsMsg = sent.filter((m) => m.type === 'toggleWindowFullscreen').at(-1);
  assert.equal(typeof fsMsg.exit, 'boolean');

  await deliver({ type: 'needFullscreenClick' });
  // jsdom's window fills its "screen" unless we shrink it
  Object.defineProperty(w, 'innerWidth', { value: 1280, configurable: true });
  await deliver({ type: 'needFullscreenClick' });
  w.dispatchEvent(new w.Event('resize'));
  const ov = doc.getElementById('ytpm-overlay-host');
  assert.ok(ov, 'fullscreen overlay shown');
  assert.match(ov.shadowRoot.textContent, /Click to go fullscreen/);

  const st = await deliver({ type: 'getState' });
  assert.equal(st.key, 'abc');
  const self = await deliver({ type: 'selftest' });
  assert.ok(self.results.length >= 5, 'self-test produced results');
  await deliver({ type: 'orphaned' });
  assert.ok(!doc.documentElement.classList.contains('ytpm-player'), 'orphan restores normal page');
  assert.deepEqual(t.errors, []);
  console.log('player ok');
}
process.exit(0);
