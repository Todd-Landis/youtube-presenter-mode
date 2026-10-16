// Entry point: pick the site adapter, then decide whether this tab is the
// player, the controller, or idle.
'use strict';
(() => {
  YTPM.site = YTPM.pickSite();
  let role = null;

  // Keyboard/media guards must be in place before the site's own scripts run.
  // They stay inert until this tab becomes a controller.
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

  // Is a session running or starting? Read from storage so idle pages on
  // every site don't wake the background.
  async function sessionLikely() {
    try {
      const { presence } = await YTPM.ext.storage.local.get('presence');
      return !!presence && (presence.active || Date.now() - (presence.starting || 0) < 15000);
    } catch {
      return true;
    }
  }

  (async () => {
    let hello = (await sessionLikely()) ? await YTPM.send({ type: 'hello' }) : { role: null };
    // Retry if the message was lost, or while a session is starting: a new
    // player window can load before the background has recorded its tab id.
    for (let i = 0; (hello == null || hello.wait) && i < 12; i++) {
      await YTPM.sleep(300);
      hello = await YTPM.send({ type: 'hello' });
    }
    role = hello?.role ?? 'none';
    if (role === 'player') {
      YTPM.Controller.setEnabled(false);
      YTPM.Player.prepare();
      YTPM.Player.start(hello);
      // The page-world bridge can take a few seconds to load (or never load in
      // Safari); the player starts without it and upgrades when it arrives.
      if (YTPM.site.usesBridge) YTPM.initBridge().then(() => YTPM.Player.onBridge());
    } else {
      YTPM.Controller.init(hello);
    }
  })();
})();
