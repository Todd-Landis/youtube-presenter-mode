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
    // Until the role is known a command can't run here. Saying so lets the
    // background queue it for the player's first state report instead.
    if (role === null && msg.type === 'cmd') {
      sendResponse({ ok: false, notReady: true });
      return true;
    }
    const target = role === 'player' ? YTPM.Player : YTPM.Controller;
    Promise.resolve()
      .then(() => target.onMessage(msg))
      .then((r) => sendResponse(r ?? { ok: true }), (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  });

  (async () => {
    // The page-world bridge can take a few seconds to load (or never load in
    // Safari); the player starts without it and upgrades when it arrives.
    const bridgeReady = YTPM.initBridge();
    let hello = await YTPM.send({ type: 'hello' });
    // Retry if the message was lost, and in a player window, which can load
    // before the background has recorded its tab id.
    for (let i = 0; (hello == null || (hinted && hello.role !== 'player')) && i < 10; i++) {
      await YTPM.sleep(300);
      hello = await YTPM.send({ type: 'hello' });
    }
    role = hello?.role ?? 'none';
    if (role === 'player') {
      YTPM.Controller.setEnabled(false);
      YTPM.Player.start(hello);
      bridgeReady.then(() => YTPM.Player.onBridge());
    } else {
      if (hinted) YTPM.Player.unprepare();
      YTPM.Controller.init(hello);
    }
  })();
})();
