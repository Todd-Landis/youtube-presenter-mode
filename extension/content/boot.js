// Entry point: decide whether this tab is the player, the controller, or idle.
'use strict';
(() => {
  const hinted = location.hash.includes(YTPM.PLAYER_HASH);
  let role = null;

  // Keyboard/media guards must be in place before YouTube's own scripts run.
  // They stay inert until this tab becomes a controller.
  if (hinted) YTPM.Player.prepare();
  YTPM.Controller.installGuards();

  YTPM.ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const target = role === 'player' ? YTPM.Player : YTPM.Controller;
    Promise.resolve()
      .then(() => target.onMessage(msg))
      .then((r) => sendResponse(r ?? { ok: true }), (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  });

  (async () => {
    const bridgeReady = YTPM.initBridge();
    let hello = await YTPM.send({ type: 'hello' });
    // The player window can load before the background has recorded its tab id.
    for (let i = 0; hinted && hello?.role !== 'player' && i < 10; i++) {
      await YTPM.sleep(300);
      hello = await YTPM.send({ type: 'hello' });
    }
    await bridgeReady;
    role = hello?.role ?? null;
    if (role === 'player') {
      YTPM.Controller.setEnabled(false);
      YTPM.Player.start(hello);
    } else {
      if (hinted) YTPM.Player.unprepare();
      YTPM.Controller.init(hello);
    }
  })();
})();
