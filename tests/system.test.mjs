// End-to-end scenarios against the harness: real extension code, simulated
// Safari and YouTube. Run: node tests/system.test.mjs [name-filter]
import assert from 'node:assert/strict';
import { World, CATALOG, sleep, until, rng } from './harness.mjs';

const filter = process.argv[2];
const tests = [];
const test = (name, fn, opts = {}) => tests.push({ name, fn, opts });

// ---- helpers -------------------------------------------------------------------

async function present(world, videoId = 'vidAlpha001') {
  const ctrl = await world.openController(videoId);
  await until(() => ctrl.presenterButton(), 3000, 'presenter button');
  ctrl.userClick(ctrl.presenterButton());
  await until(() => world.playerPage()?.listener, 4000, 'player window loaded');
  await until(() => ctrl.bar()?.title === CATALOG[videoId].title, 4000, 'bar shows the TV title');
  return ctrl;
}

const tv = (world) => world.playerPage();
const tvVideo = (world) => tv(world).yt;
const tvWin = (world) => world.windows.get(world.session()?.playerWindowId);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

async function settle(world, ms = 1200) {
  Object.assign(world.o, { dropToTab: 0, dropReplyToTab: 0, dropToBg: 0 });
  await sleep(ms);
}

function noErrors(world) {
  assert.deepEqual(world.errors, [], 'no script errors');
}

// ---- happy path ------------------------------------------------------------------

test('happy path: start, fullscreen, pause/play, seek, end', async (world) => {
  const ctrl = await present(world);
  const local = ctrl.yt;
  assert.equal(local.v.paused, true, 'Mac video paused');
  assert.equal(local.v.muted, true, 'Mac video muted');
  await until(() => tvWin(world)?.state === 'fullscreen', 3000, 'TV window fullscreen');
  assert.ok(world.session(), 'session survived the about:blank load');
  await until(() => !tvVideo(world).v.paused, 2000, 'TV playing');
  await until(() => !ctrl.bar().showsPaused, 1000, 'bar shows playing');

  ctrl.barButton('Play/pause').click();
  await until(() => tvVideo(world).v.paused, 1500, 'TV paused');
  await until(() => ctrl.bar().showsPaused, 1000, 'bar shows paused');
  ctrl.barButton('Play/pause').click();
  await until(() => !tvVideo(world).v.paused, 1500, 'TV playing again');

  const t0 = tvVideo(world).now();
  ctrl.key('l');
  await until(() => tvVideo(world).now() >= t0 + 9, 1500, 'TV seeked +10');

  await sleep(600);
  const tEnd = tvVideo(world).now();
  ctrl.barButton('End').click();
  await until(() => !world.session() && world.playerWindows().length === 0, 3000, 'player window closed');
  await until(() => !ctrl.bar(), 1000, 'bar removed');
  assert.ok(near(local.v.currentTime, tEnd, 1.5), `Mac resumes at TV position (${local.v.currentTime} vs ${tEnd})`);
  assert.equal(local.v.muted, false, 'Mac unmuted');
  await sleep(1200);
  assert.equal(ctrl.bar(), null, 'bar stays gone');
  noErrors(world);
});

test('no page bridge (Safari fallback): controls still work, fast startup', async (world) => {
  const t0 = Date.now();
  const ctrl = await present(world);
  assert.ok(Date.now() - t0 < 2600, `player ready quickly without the bridge (${Date.now() - t0} ms)`);
  await until(() => !ctrl.bar().showsPaused, 1500, 'bar shows playing');
  ctrl.key('k');
  await until(() => tvVideo(world).v.paused, 1500, 'paused via DOM');
  ctrl.key('k');
  await until(() => !tvVideo(world).v.paused, 1500, 'playing via DOM');
  const t1 = tvVideo(world).now();
  ctrl.key('j');
  await until(() => tvVideo(world).now() < t1 - 5 || tvVideo(world).now() < 1, 1500, 'seek back');
  ctrl.key('c');
  await until(() => tvVideo(world).s.cc, 1500, 'captions on via button');
  ctrl.key('>', { shiftKey: true });
  await until(() => tvVideo(world).s.rate === 1.25, 1500, 'speed up');
  ctrl.key('ArrowDown');
  await until(() => tvVideo(world).s.volume < 1, 1500, 'volume down');
  noErrors(world);
}, { bridge: false });

test('scripting fallback loads the bridge when the manifest world is ignored', async (world) => {
  const ctrl = await present(world);
  await until(() => tv(world).win.YTPM.bridge.ready, 4000, 'bridge ready');
  const bridge = tv(world).win.YTPM.bridge;
  assert.equal(bridge.ready, true);
  assert.equal(bridge.info.via, 'scripting');
  ctrl.key('c');
  await until(() => tvVideo(world).s.cc, 1500, 'captions via API');
  noErrors(world);
}, { bridge: false, scripting: true });

// ---- starting --------------------------------------------------------------------

test('double-click on the presenter button opens one window', async (world) => {
  const ctrl = await world.openController();
  await until(() => ctrl.presenterButton(), 3000, 'button');
  ctrl.userClick(ctrl.presenterButton());
  ctrl.userClick(ctrl.presenterButton());
  await sleep(150);
  ctrl.userClick(ctrl.presenterButton());
  await sleep(2500);
  assert.equal(world.playerWindows().length, 1, 'exactly one player window');
  assert.ok(ctrl.bar(), 'controller is presenting');
  noErrors(world);
});

test('commands sent while the player window is still loading are not lost', async (world) => {
  const ctrl = await world.openController();
  await until(() => ctrl.presenterButton(), 3000, 'button');
  ctrl.userClick(ctrl.presenterButton());
  await until(() => ctrl.bar(), 2000, 'presenting');
  assert.ok(!tv(world)?.listener, 'TV page not loaded yet');
  ctrl.key('k'); // before the TV page exists
  await until(() => tv(world)?.listener, 4000, 'player loaded');
  await sleep(1800);
  assert.equal(tvVideo(world).v.paused, true, 'early pause applied');
  assert.ok(ctrl.bar().showsPaused, 'bar agrees');
  assert.equal(ctrl.toast()?.startsWith('TV did not respond'), false, 'no error toast');
  noErrors(world);
}, { loadDelay: [600, 800] });

test('start survives a lost reply (no duplicate window)', async (world) => {
  const ctrl = await world.openController();
  await until(() => ctrl.presenterButton(), 3000, 'button');
  world.o.dropToBg = 1;
  ctrl.userClick(ctrl.presenterButton());
  await sleep(60);
  world.o.dropToBg = 0;
  await until(() => ctrl.bar(), 4000, 'presenting after a retry');
  await sleep(1500);
  assert.equal(world.playerWindows().length, 1);
  noErrors(world);
});

// ---- connection faults ---------------------------------------------------------

test('lossy messaging: every command applied exactly once, in order', async (world) => {
  const ctrl = await present(world);
  await settle(world, 600);
  ctrl.key('k');
  await until(() => tvVideo(world).v.paused, 2000, 'paused');
  const t0 = tvVideo(world).now();
  Object.assign(world.o, { dropToTab: 0.5, dropReplyToTab: 0.2, dropToBg: 0.3, delay: [0, 60] });
  for (let i = 0; i < 4; i++) { ctrl.key('l'); await sleep(120); }
  ctrl.key('j');
  await sleep(200);
  await settle(world, 2500);
  assert.ok(near(tvVideo(world).now(), t0 + 30, 0.6), `seeks applied once each: ${tvVideo(world).now()} vs ${t0 + 30}`);
  assert.equal(tvVideo(world).v.paused, true, 'still paused');
  noErrors(world);
}, { seed: 7 });

test('order kept when one command is queued and the next goes direct', async (world) => {
  const ctrl = await present(world);
  await settle(world, 600);
  world.o.dropToTab = 1;
  ctrl.barButton('Play/pause').click(); // pause → queued
  await sleep(400);
  world.o.dropToTab = 0;
  ctrl.barButton('Play/pause').click(); // play → would go direct
  await settle(world, 1800);
  assert.equal(tvVideo(world).v.paused, false, 'TV ends up playing (last command wins)');
  assert.equal(ctrl.bar().showsPaused, false, 'bar agrees');
  noErrors(world);
});

test('End is retried if the first message is lost', async (world) => {
  const ctrl = await present(world);
  world.o.dropToBg = 1;
  ctrl.barButton('End').click();
  await sleep(80);
  world.o.dropToBg = 0;
  await until(() => world.playerWindows().length === 0, 3000, 'player window closed');
  await until(() => !ctrl.bar(), 1000, 'bar removed');
  noErrors(world);
});

test('a state report that arrives after End does not bring the bar back', async (world) => {
  const ctrl = await present(world);
  const old = world.session();
  const lastState = world.bgEval('lastState');
  ctrl.barButton('End').click();
  await until(() => !ctrl.bar(), 2000, 'bar gone');
  await ctrl.receive({ type: 'state', state: { ...lastState, sentAt: Date.now() }, session: old });
  await sleep(300);
  assert.equal(ctrl.bar(), null, 'bar stays gone');
  noErrors(world);
});

test('background page unloaded mid-session', async (world) => {
  const ctrl = await present(world);
  await sleep(500);
  world.restartBackground();
  ctrl.key('k');
  await until(() => tvVideo(world).v.paused, 2000, 'command works after restart');
  await sleep(1000);
  assert.ok(/live/.test(ctrl.barRoot().querySelector('.dot').className), 'state still flowing');
  world.restartBackground();
  ctrl.barButton('End').click();
  await until(() => world.playerWindows().length === 0, 3000, 'End works after restart');
  noErrors(world);
});

test('bar never contradicts the TV after a burst of clicks', async (world) => {
  const ctrl = await present(world);
  await until(() => !ctrl.bar().showsPaused, 1500, 'bar shows playing');
  Object.assign(world.o, { delay: [20, 120], dropToTab: 0.3 });
  for (let i = 0; i < 7; i++) { ctrl.barButton('Play/pause').click(); await sleep(70); }
  await settle(world, 2000);
  assert.equal(ctrl.bar().showsPaused, tvVideo(world).v.paused, 'bar matches TV');
  assert.equal(tvVideo(world).v.paused, true, '7 toggles from playing = paused');
  noErrors(world);
}, { seed: 3 });

// ---- reloads & lifecycle ---------------------------------------------------------

test('TV page reload resumes where it was, not at the original start', async (world) => {
  const ctrl = await present(world);
  tvVideo(world).v.currentTime = 95;
  await sleep(1000);
  const t = tvVideo(world).now();
  const s = world.session();
  world.navigateTab(s.playerTabId, world.tabs.get(s.playerTabId).page.win.location.href);
  await until(() => tv(world)?.listener && tvVideo(world).now() > 50, 4000, 'TV back');
  assert.ok(near(tvVideo(world).now(), t, 3), `resumed near ${t}, got ${tvVideo(world).now()}`);
  assert.equal(tvWin(world).state, 'fullscreen', 'still fullscreen');
  assert.ok(ctrl.bar(), 'still presenting');
  noErrors(world);
});

test('TV autoplays the next video, then reloads: stays on the new video', async (world) => {
  const ctrl = await present(world);
  tvVideo(world).v.currentTime = 299;
  await until(() => tvVideo(world).s.id === 'vidBravo002', 3000, 'autoplay next');
  await until(() => ctrl.bar().title === 'Bravo', 2000, 'bar shows Bravo');
  await sleep(1500);
  const s = world.session();
  world.navigateTab(s.playerTabId, tv(world).win.location.href);
  await until(() => tv(world)?.listener && tvVideo(world).now() > 0.5, 4000, 'TV back');
  assert.equal(tvVideo(world).s.id, 'vidBravo002');
  assert.ok(tvVideo(world).now() < 10, `not seeked to Alpha's start (${tvVideo(world).now()})`);
  noErrors(world);
});

test('controller tab reload keeps presenting', async (world) => {
  let ctrl = await present(world);
  const tabId = ctrl.tab.id;
  world.navigateTab(tabId, ctrl.win.location.href);
  await until(() => world.tabs.get(tabId).page?.bar(), 4000, 'bar back after reload');
  ctrl = world.tabs.get(tabId).page;
  await sleep(300);
  assert.equal(ctrl.yt.v.paused, true, 'reloaded Mac video held');
  ctrl.key('k');
  await until(() => tvVideo(world).v.paused, 2000, 'commands work');
  noErrors(world);
});

test('closing the TV window ends presenter mode cleanly', async (world) => {
  const ctrl = await present(world);
  await sleep(800);
  const t = tvVideo(world).now();
  world.closeTab(world.session().playerTabId);
  await until(() => !ctrl.bar(), 2000, 'bar gone');
  assert.match(ctrl.toast() || '', /closed/);
  assert.ok(near(ctrl.yt.v.currentTime, t, 1.5), 'Mac parked at the TV position');
  noErrors(world);
});

test('closing the controller releases the TV window', async (world) => {
  const ctrl = await present(world);
  const page = tv(world);
  world.closeTab(ctrl.tab.id);
  await until(() => !page.doc.documentElement.classList.contains('ytpm-player'), 2000, 'player back to normal YouTube');
  assert.equal(world.session(), null);
  noErrors(world);
});

// ---- fullscreen --------------------------------------------------------------------

test('fullscreen ignored while loading: retried until it sticks', async (world) => {
  await present(world);
  await until(() => tvWin(world).state === 'fullscreen', 9000, 'fullscreen on a retry');
  assert.equal(tv(world).overlayKind(), null, 'no click needed');
  const macWin = world.tabs.get(world.session().controllerTabId).windowId;
  await until(() => world.focused === macWin, 3500, 'focus handed back to the Mac tab');
  noErrors(world);
}, { fullscreen: 'afterLoad' });

test('fullscreen never works: asks for one click, which works', async (world) => {
  const ctrl = await present(world);
  await until(() => tv(world).overlayKind() === 'fullscreen', 14000, 'click overlay');
  await until(() => /click on the TV|click to go fullscreen/i.test((ctrl.toast() || '') + (ctrl.bar().warn || '')), 2000, 'Mac told');
  tv(world).clickOverlay();
  await until(() => tv(world).doc.fullscreenElement, 1000, 'element fullscreen');
  await sleep(600);
  assert.equal(tv(world).overlayKind(), null);
  assert.equal(ctrl.bar().warn, null, 'warning cleared');
  noErrors(world);
}, { fullscreen: 'ignored' });

test('leaving fullscreen on the TV yourself is respected', async (world) => {
  const ctrl = await present(world);
  await until(() => tvWin(world).state === 'fullscreen', 3000, 'fullscreen');
  await sleep(500);
  world.userExitFullscreen(tvWin(world).id);
  await sleep(6500);
  assert.equal(tvWin(world).state, 'normal', 'not forced back');
  ctrl.key('f');
  await until(() => tvWin(world).state === 'fullscreen', 4000, 'F puts it back');
  ctrl.key('f');
  await until(() => tvWin(world).state === 'normal', 4000, 'F takes it out');
  noErrors(world);
});

test('going fullscreen stays fullscreen (transition glitch, repeated requests)', async (world) => {
  const ctrl = await present(world);
  await until(() => tvWin(world).state === 'fullscreen', 3000, 'fullscreen');
  // Long enough for every automatic retry and the 2.5 s verification.
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    assert.equal(tvWin(world).state, 'fullscreen', `still fullscreen after ${(i + 1) / 2} s`);
  }
  assert.equal(tvVideo(world).v.paused, false, 'still playing');
  assert.ok(!/disconnect/i.test(ctrl.toast() || ''), 'no false "TV disconnected"');
  noErrors(world);
});

test('fullscreen ignored at first, Safari toggles on repeat requests: ends up fullscreen', async (world) => {
  await present(world);
  await until(() => tvWin(world).state === 'fullscreen', 9000, 'fullscreen on a retry');
  await sleep(9000);
  assert.equal(tvWin(world).state, 'fullscreen', 'no later request toggled it back out');
  noErrors(world);
}, { fullscreen: 'afterLoad' });

test('TV display disconnects: playback pauses and the Mac is not taken over', async (world) => {
  const ctrl = await present(world);
  await until(() => tvWin(world).state === 'fullscreen', 3000, 'fullscreen');
  await sleep(6000); // mid-video, not during the fullscreen animation
  world.disconnectTv();
  // Confirmed after ~3 s, so a fullscreen animation can't trigger it.
  await sleep(1500);
  assert.equal(tvVideo(world).v.paused, false, 'not paused on a momentary blip');
  await until(() => tvVideo(world).v.paused, 5000, 'paused');
  await until(() => /disconnect/i.test(ctrl.toast() || ''), 2000, 'remote says the TV disconnected');
  await until(() => tvWin(world).state === 'normal', 3500, 'out of fullscreen on the Mac');
  noErrors(world);
});

// ---- switching videos -------------------------------------------------------------

for (const bridge of [true, false]) {
  test(`picking another video in the controller plays it on the TV (bridge ${bridge})`, async (world) => {
    const ctrl = await present(world);
    ctrl.spaNavigate('/watch?v=vidCharl003');
    await until(() => tvVideo(world)?.s.id === 'vidCharl003', 4000, 'TV switched');
    await until(() => ctrl.bar().title === 'Charlie', 3000, 'bar title');
    await sleep(300);
    assert.equal(ctrl.yt.v.paused, true, 'Mac copy held');
    ctrl.spaNavigate('/watch?v=vidBravo002&t=42s');
    await until(() => tvVideo(world)?.s.id === 'vidBravo002', 4000, 'TV switched again');
    await until(() => tvVideo(world).now() >= 41, 2000, 'started at the link timestamp');
    assert.equal(world.session().key, 'vidBravo002');
    assert.equal(world.playerWindows().length, 1);
    noErrors(world);
  }, { bridge });
}

test('a playlist link reloads the TV page and keeps fullscreen', async (world) => {
  const ctrl = await present(world);
  await until(() => tvWin(world).state === 'fullscreen', 3000, 'fullscreen');
  ctrl.spaNavigate('/watch?v=vidCharl003&list=PLx&index=2');
  await until(() => tv(world)?.win.location.search.includes('list=PLx') && tv(world).listener, 4000, 'TV reloaded with the playlist');
  await until(() => tvVideo(world).s.id === 'vidCharl003' && !tvVideo(world).v.paused, 3000, 'playing');
  assert.equal(tvWin(world).state, 'fullscreen');
  noErrors(world);
});

test('Shorts in the controller go to the TV; the Mac short stays silent', async (world) => {
  const ctrl = await present(world);
  ctrl.spaNavigate('/shorts/vidShort004');
  await until(() => tvVideo(world).s.id === 'vidShort004', 4000, 'TV plays the short');
  await sleep(400);
  assert.ok(ctrl.shorts.v.paused || ctrl.shorts.v.muted, 'Mac short not playing with sound');
  noErrors(world);
});

test('timestamp or chapter link in the controller seeks the TV', async (world) => {
  const ctrl = await present(world);
  await sleep(1800);
  ctrl.clickTimestamp(150);
  await until(() => near(tvVideo(world).now(), 150, 2), 2000, 'TV at 150 s');
  noErrors(world);
});

test('live stream: LIVE label, no percentage seeking', async (world) => {
  const ctrl = await present(world);
  ctrl.spaNavigate('/watch?v=vidLiveS005');
  await until(() => tvVideo(world).s.id === 'vidLiveS005', 4000, 'live on TV');
  await until(() => /LIVE/.test(ctrl.bar().time), 2000, 'LIVE label');
  assert.equal(ctrl.bar().scrubDisabled, true);
  const t = tvVideo(world).now();
  ctrl.key('5');
  await sleep(800);
  assert.ok(tvVideo(world).now() < t + 3, 'no jump');
  assert.ok(!/NaN/.test(ctrl.bar().time));
  noErrors(world);
});

test('unplayable video: the controller says so', async (world) => {
  const ctrl = await present(world);
  ctrl.spaNavigate('/watch?v=vidError006');
  await until(() => /can't play|cannot play|unavailable/i.test(ctrl.bar().warn || ''), 4000, 'error shown');
  noErrors(world);
});

// ---- keyboard --------------------------------------------------------------------

test('holding a key: toggles fire once, seeks repeat; IME input ignored', async (world) => {
  const ctrl = await present(world);
  await until(() => !ctrl.bar().showsPaused, 1500, 'bar shows playing');
  ctrl.key(' ');
  for (let i = 0; i < 5; i++) ctrl.key(' ', { repeat: true });
  await settle(world, 1200);
  assert.equal(tvVideo(world).v.paused, true, 'one toggle');
  const t = tvVideo(world).now();
  ctrl.key('ArrowRight');
  for (let i = 0; i < 3; i++) ctrl.key('ArrowRight', { repeat: true });
  await until(() => near(tvVideo(world).now(), t + 20, 1), 2000, 'four seeks');
  ctrl.key('k', { isComposing: true });
  await sleep(600);
  assert.equal(tvVideo(world).v.paused, true, 'composition key ignored');
  ctrl.key('k', {}, ctrl.doc.getElementById('contenteditable-root'));
  await sleep(600);
  assert.equal(tvVideo(world).v.paused, true, 'typing in a comment ignored');
  noErrors(world);
});

// ---- Twitch ------------------------------------------------------------------------

const TW = 'https://www.twitch.tv/';

async function presentTwitch(world, path = 'streamerone') {
  const ctrl = await world.openController(TW + path);
  await until(() => ctrl.presenterButton(), 3000, 'presenter button in Twitch controls');
  ctrl.userClick(ctrl.presenterButton());
  await until(() => world.playerPage()?.listener, 4000, 'player window loaded');
  return ctrl;
}

test('Twitch live: button in the controls, TV fills, LIVE, pause/play, End', async (world) => {
  const ctrl = await presentTwitch(world);
  const btn = ctrl.presenterButton();
  assert.ok(btn.closest('.player-controls__right-control-group'), 'button sits in the right control group');
  assert.ok(btn.closest('#ytpm-btn-wrap').nextElementSibling.contains(ctrl.doc.querySelector('[data-a-target="player-fullscreen-button"]')), 'before fullscreen');
  assert.match(world.tabs.get(world.session().playerTabId).url, /^https:\/\/www\.twitch\.tv\/streamerone$/);
  await until(() => ctrl.bar()?.title === 'streamerone', 4000, 'bar title');
  await until(() => /LIVE/.test(ctrl.bar().time), 2000, 'LIVE label');
  const fill = tv(world).doc.querySelector('[data-ytpm-fill]');
  assert.equal(fill?.getAttribute('data-a-target'), 'video-player', 'the Twitch player container fills the TV');
  assert.ok(tv(world).doc.querySelector('[data-a-target="video-ref"][data-ytpm-fill-path]'), 'wrappers stretched');
  await until(() => tvWin(world).state === 'fullscreen', 3000, 'fullscreen');
  assert.equal(ctrl.yt.v.paused, true, 'Mac stream paused');
  assert.ok(ctrl.doc.querySelector('[data-a-target="video-player"] > #ytpm-shield'), 'shield over the Mac player');
  await until(() => !ctrl.bar().showsPaused, 1500, 'bar shows playing');
  ctrl.key('k');
  await until(() => tvVideo(world).v.paused, 1500, 'TV paused');
  assert.equal(tv(world).doc.querySelector('[data-a-target="player-play-pause-button"]').getAttribute('data-a-player-state'), 'paused', "Twitch's own state agrees");
  ctrl.key(' ');
  await until(() => !tvVideo(world).v.paused, 1500, 'TV playing');
  const t = tvVideo(world).now();
  ctrl.key('5');
  ctrl.key('>', { shiftKey: true });
  await sleep(800);
  assert.ok(tvVideo(world).now() < t + 3 && tvVideo(world).s.rate === 1, 'no percentage seek or speed change on live');
  ctrl.key('k', {}, ctrl.doc.querySelector('[data-a-target="chat-input"]'));
  await sleep(500);
  assert.equal(tvVideo(world).v.paused, false, 'typing in chat stays in chat');
  ctrl.barButton('End').click();
  await until(() => world.playerWindows().length === 0 && !ctrl.bar(), 3000, 'ended');
  assert.equal(ctrl.yt.v.muted, false);
  noErrors(world);
});

test('Twitch: switching channel in the Mac tab switches the TV', async (world) => {
  const ctrl = await presentTwitch(world);
  await until(() => tvWin(world)?.state === 'fullscreen', 3000, 'fullscreen');
  ctrl.spaNavigate('/streamertwo'); // no YouTube-style event: the URL just changes
  await until(() => tv(world)?.listener && tvVideo(world)?.s.id === 'live:streamertwo', 5000, 'TV on the new channel');
  await until(() => ctrl.bar().title === 'streamertwo', 3000, 'bar title');
  assert.equal(tvWin(world).state, 'fullscreen', 'still fullscreen after the page load');
  assert.equal(world.session().key, 'live:streamertwo');
  await sleep(500);
  assert.equal(ctrl.yt.v.paused, true, 'Mac copy held');
  ctrl.spaNavigate('/directory');
  await sleep(1200);
  assert.equal(tvVideo(world).s.id, 'live:streamertwo', 'browsing the directory leaves the TV alone');
  noErrors(world);
});

test('Twitch VOD: starts at the Mac position, seeks work', async (world) => {
  const ctrl = await world.openController(TW + 'videos/111?t=10m0s');
  await until(() => ctrl.presenterButton() && ctrl.yt.now() >= 599, 3000, 'VOD at 10:00');
  ctrl.userClick(ctrl.presenterButton());
  await until(() => tv(world)?.listener, 4000, 'TV loaded');
  assert.match(world.tabs.get(world.session().playerTabId).url, /videos\/111\?t=10m\ds/);
  await until(() => near(tvVideo(world).now(), 601, 3), 3000, 'TV near 10:00');
  await until(() => !ctrl.bar().showsPaused, 1500, 'bar shows playing');
  const t = tvVideo(world).now();
  ctrl.key('l');
  await until(() => tvVideo(world).now() >= t + 9, 1500, '+10 s');
  noErrors(world);
});

test('Twitch mature-content gate on the TV is accepted', async (world) => {
  const ctrl = await presentTwitch(world);
  ctrl.spaNavigate('/maturechan');
  await until(() => tvVideo(world)?.s.id === 'live:maturechan', 5000, 'TV on the gated channel');
  await until(() => !tvVideo(world).v.paused, 7000, 'gate accepted, playing');
  noErrors(world);
});

// ---- any other site --------------------------------------------------------------

const SITE = 'https://videos.example.com/';

test('any site: start from the toolbar, main video (not the decoy) fills the TV', async (world) => {
  const ctrl = await world.openController(SITE + 'films/one');
  ctrl.yt.v.play();
  await sleep(1500);
  assert.equal(ctrl.presenterButton(), null, 'no in-page button on unknown sites');
  const r = await world.popupStart();
  assert.notEqual(r?.ok, false, 'popup start accepted');
  await until(() => tv(world)?.listener, 4000, 'TV loaded');
  assert.equal(world.tabs.get(world.session().playerTabId).url, SITE + 'films/one');
  await until(() => ctrl.bar()?.title === 'Film one', 4000, 'bar title from og:title');
  const main = tv(world).doc.querySelector('.player-shell video');
  await until(() => main.hasAttribute('data-ytpm-fill'), 2000, 'main video fills');
  assert.equal(tv(world).doc.querySelector('header video').hasAttribute('data-ytpm-fill'), false, 'decoy left alone');
  await until(() => !tvVideo(world).v.paused && near(tvVideo(world).now(), ctrl.yt.v.currentTime + 1, 3), 3000, 'TV playing from the Mac position');
  assert.equal(ctrl.yt.v.paused, true, 'Mac copy paused');
  assert.equal(ctrl.bar().warn, null);
  await until(() => !ctrl.bar().showsPaused, 1500, 'bar shows playing');
  ctrl.key('k');
  await until(() => tvVideo(world).v.paused, 1500, 'paused');
  ctrl.key('7');
  await until(() => near(tvVideo(world).now(), 168, 1), 1500, '70 %');
  ctrl.key('c'); // no text tracks: nothing to toggle, nothing breaks
  ctrl.key('N', { shiftKey: true }); // no "next" here
  await sleep(500);
  world.shortcut(); // ⌥⇧P ends it
  await until(() => world.playerWindows().length === 0 && !ctrl.bar(), 3000, 'ended by the shortcut');
  assert.ok(near(ctrl.yt.v.currentTime, 168, 1.5), 'Mac parked at the TV position');
  noErrors(world);
});

test('any site: the site\'s own scrubber on the Mac moves the TV', async (world) => {
  const ctrl = await world.openController(SITE + 'films/two');
  ctrl.yt.v.play();
  await sleep(500);
  world.shortcut();
  await until(() => tv(world)?.listener && ctrl.bar(), 4000, 'presenting');
  await sleep(1800);
  ctrl.clickTimestamp(90);
  await until(() => near(tvVideo(world).now(), 90, 2), 2000, 'TV at 90 s');
  noErrors(world);
});

test('any site: a page without a video says so', async (world) => {
  const ctrl = await world.openController(SITE + 'no-video');
  await world.popupStart();
  await until(() => /No video found/.test(ctrl.toast() || ''), 2000, 'told there is no video');
  assert.equal(world.playerWindows().length, 0);
  noErrors(world);
});

test('idle pages stay quiet: no messages to the background without a session', async (world) => {
  await world.openController(SITE + 'films/one');
  await world.openController('vidAlpha001');
  await world.openController(TW + 'streamerone');
  await sleep(800);
  assert.equal(world.bgMessages('hello').length, 0, 'no hello from idle pages');
});

// ---- other modes ---------------------------------------------------------------------

test('AirPlay mode: no fullscreen attempts, asks for the AirPlay click', async (world) => {
  world.storage.local.settings = { mode: 'airplay' };
  const ctrl = await world.openController();
  await until(() => ctrl.presenterButton(), 3000, 'button');
  ctrl.userClick(ctrl.presenterButton());
  await until(() => tv(world)?.overlayKind() === 'airplay', 4000, 'AirPlay prompt');
  await sleep(3000);
  assert.equal(tvWin(world).state, 'normal');
  noErrors(world);
});

// ---- fuzz --------------------------------------------------------------------------

// FUZZ_SEEDS=1,2,3 runs more seeds; FUZZ_BRIDGE=0 fuzzes the no-bridge (DOM fallback) path.
const fuzzSeeds = (process.env.FUZZ_SEEDS || '11,22,33').split(',').map(Number);
const fuzzBridge = process.env.FUZZ_BRIDGE !== '0';
for (const seed of fuzzSeeds) {
  test(`fuzz: random use under random faults (seed ${seed}${fuzzBridge ? '' : ', no bridge'})`, async (world) => {
    const r = rng(seed);
    let ctrl = await present(world);
    const ctrlTab = ctrl.tab.id;
    const pick = (a) => a[Math.floor(r() * a.length)];
    const actions = [
      () => ctrl.barButton('Play/pause')?.click(),
      () => ctrl.key(pick([' ', 'k', 'j', 'l', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'm', 'c', '3', '7'])),
      () => ctrl.key(pick(['<', '>']), { shiftKey: true }),
      () => ctrl.spaNavigate('/watch?v=' + pick(['vidAlpha001', 'vidBravo002', 'vidCharl003'])),
      () => ctrl.clickTimestamp(Math.floor(r() * 100)),
      () => { tvVideo(world) && (tvVideo(world).v.currentTime = 1e6); }, // video ends → autoplay next
      () => { const s = world.session(); if (s && tv(world)) world.navigateTab(s.playerTabId, tv(world).win.location.href); },
      () => { world.navigateTab(ctrlTab, ctrl.win.location.href); },
      () => world.restartBackground(),
      () => { const w = tvWin(world); if (w) world.userExitFullscreen(w.id); },
      () => Object.assign(world.o, { dropToTab: r() * 0.6, dropReplyToTab: r() * 0.3, dropToBg: r() * 0.4, delay: [0, Math.floor(r() * 120)] }),
      () => Object.assign(world.o, { dropToTab: 0, dropReplyToTab: 0, dropToBg: 0, delay: [0, 15] }),
    ];
    const weights = [4, 6, 1, 2, 1, 1, 1, 1, 1, 1, 2, 2];
    const bag = weights.flatMap((n, i) => Array(n).fill(i));
    for (let step = 0; step < 45; step++) {
      ctrl = world.tabs.get(ctrlTab)?.page || ctrl;
      try { actions[pick(bag)](); } catch (e) { if (!/Cannot read|null/.test(e.message)) throw e; }
      await sleep(60 + Math.floor(r() * 350));
    }
    await settle(world, 3000);
    ctrl = world.tabs.get(ctrlTab).page;
    assert.ok(world.session(), 'still presenting');
    assert.equal(world.playerWindows().length, 1, 'one player window');
    const bar = ctrl.bar();
    assert.ok(bar, 'bar visible');
    assert.equal(bar.showsPaused, tvVideo(world).v.paused, 'bar play state matches the TV');
    assert.equal(bar.title, CATALOG[tvVideo(world).s.id].title, 'bar title matches the TV');
    assert.equal(ctrl.yt.v.paused || ctrl.yt.v.muted, true, 'Mac copy silent');
    ctrl.barButton('End').click();
    await until(() => world.playerWindows().length === 0 && !ctrl.bar(), 4000, 'End cleans up');
    noErrors(world);
  }, { seed, bridge: fuzzBridge });
}

// ---- runner ------------------------------------------------------------------------

const results = [];
for (const t of tests) {
  if (filter && !t.name.includes(filter)) continue;
  const world = new World(t.opts);
  const started = Date.now();
  try {
    await t.fn(world);
    results.push({ name: t.name, ok: true, ms: Date.now() - started });
    console.log(`  ok   ${t.name} (${Date.now() - started} ms)`);
  } catch (e) {
    results.push({ name: t.name, ok: false, error: e.message });
    console.log(`  FAIL ${t.name}\n       ${e.message.split('\n').slice(0, 6).join('\n       ')}`);
    // Full detail for later: SYSTEM_TEST_LOG=path keeps every failure's errors.
    if (process.env.SYSTEM_TEST_LOG) {
      const fs = await import('node:fs');
      fs.appendFileSync(process.env.SYSTEM_TEST_LOG, `\n=== ${t.name}\n${e.stack}\n${world.errors.join('\n---\n')}\n`);
    }
    if (world.errors.length) console.log('       script errors:', world.errors.slice(0, 3).join('\n       '));
  } finally {
    await world.dispose();
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} system scenarios passed`);
process.exit(failed.length ? 1 : 0);
