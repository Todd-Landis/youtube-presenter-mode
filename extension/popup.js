'use strict';
const ext = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

async function refresh() {
  const r = await ext.runtime.sendMessage({ type: 'popup:status' });
  const { session, lastState, settings } = r;
  for (const el of document.querySelectorAll('input[name=mode]')) el.checked = el.value === settings.mode;
  $('autoFullscreen').checked = !!settings.autoFullscreen;
  $('start').hidden = !!session;
  $('end').hidden = !session;
  const status = $('status');
  status.replaceChildren();
  const b = document.createElement('b');
  const span = document.createElement('span');
  if (session) {
    b.textContent = session.mode === 'airplay' ? 'Presenting via AirPlay' : 'Presenting on the TV display';
    span.textContent = lastState?.title || 'Waiting for the player window…';
  } else {
    b.textContent = 'Idle';
    span.textContent = 'Open a page with a video (YouTube, Twitch or any site), then start or press ⌥⇧P.';
  }
  status.append(b, span);
}

async function setSettings(settings) {
  await ext.runtime.sendMessage({ type: 'settings:set', settings });
}

for (const el of document.querySelectorAll('input[name=mode]')) {
  el.addEventListener('change', () => setSettings({ mode: el.value }));
}
$('autoFullscreen').addEventListener('change', (e) => setSettings({ autoFullscreen: e.target.checked }));

$('start').addEventListener('click', async () => {
  const r = await ext.runtime.sendMessage({ type: 'popup:start' });
  if (r?.ok === false) $('err').textContent = r.error;
  else window.close();
});
$('end').addEventListener('click', async () => {
  await ext.runtime.sendMessage({ type: 'popup:end' });
  window.close();
});
$('diag').addEventListener('click', () => {
  ext.tabs.create({ url: ext.runtime.getURL('diagnostics.html') });
  window.close();
});
$('forget').addEventListener('click', async () => {
  await ext.runtime.sendMessage({ type: 'diag:forgetTv' });
  $('err').textContent = 'TV window position forgotten.';
});

refresh();
