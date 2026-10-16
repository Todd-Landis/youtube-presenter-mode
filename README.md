# Presenter Mode

A Safari extension that turns a video tab into a two-screen setup. The video
plays fullscreen on your Apple TV, and the original tab on your Mac becomes a
remote control. Use other apps freely; playback stays on the TV.

It works with **YouTube**, **Twitch**, and **any other site** that plays its
video in a standard `<video>` element.

Playback stays in Safari on the Mac, so the browser-side ad blocking you
already use keeps working. The Apple TV apps don't get that.

## How it works

Starting presenter mode opens a second window, the **player**, at the current
position. The original tab becomes the **controller**: its video pauses and
mutes, and a remote bar appears along the bottom.

There are two ways to get the picture to the TV. Choose one in the toolbar
popup:

| Mode | How it works |
|---|---|
| **Extended display** (default) | The player window goes fullscreen on the Apple TV, used as an AirPlay "Separate Display". |
| **AirPlay video** (experimental) | The player window stays on the Mac and AirPlays its video to the Apple TV. No extra desktop. |

### Sites

| | YouTube | Twitch | Any other site |
|---|---|---|---|
| Start from | Button in the player controls, ⌥⇧P, toolbar | Button in the player controls, ⌥⇧P, toolbar | ⌥⇧P or toolbar |
| What plays on the TV | Watch pages, Shorts, live links | Live channels, past broadcasts, clips | The page's main video (the largest; muted background loops are ignored) |
| Picking another video on the Mac | Plays it on the TV | Plays it on the TV | Start again on the new page |
| Captions | Yes | When the stream has them | When the site uses standard caption tracks |
| Prompts dismissed on the TV | "Continue watching?" | Mature-content gate | — |

On every site: play/pause, seeking, volume and mute. Speed too, except on live
streams.

### Move mode (experimental)

On other sites, the TV normally opens the same page address. In a feed (X,
Reddit, Instagram) the address doesn't say which video you were watching, so
the TV may show a different one. **Move mode** (toolbar popup ▸ "Move the video
instead of reopening the page") moves the video you're watching instead:

1. Start as usual with ⌥⇧P or the toolbar. The page asks **Move this video to
   the TV?** Click **Move to TV**: Safari only lets a page open a window from a
   click on it.
2. The page opens a window and moves its own `<video>` element into it. The
   extension puts that window on the TV and makes it fullscreen, as usual.
3. The site's scripts keep running that element from the original tab, so the
   stream, position, quality and ad state carry over. A placeholder keeps the
   video's spot in the feed; clicking it plays or pauses the TV. The remote bar
   and the shortcuts work as usual.
4. **End**, or closing the TV window, puts the video back in its spot, paused.

It only applies to sites other than YouTube and Twitch, which keep opening
their own page, and only with **Extended display**. Its limits:
- **Playback depends on the original tab.** Closing the tab closes the TV
  window. Reloading it, or leaving the page, ends presenter mode, unless the
  video is a plain file rather than a MediaSource stream; a plain file keeps
  playing and the reloaded page takes over the remote.
- Safari slows a hidden tab's timers (another tab in front, or the window
  covered). If the site feeds its video from those timers, the TV can run dry
  and stall until the tab is visible again. The remote bar flags the stall.
- If the site tears down its player (say you scroll far away in the feed), the
  TV stops.
- Feeds pause videos they can no longer see. Move mode plays on (up to four
  times a minute), unless you paused it yourself, from the remote or with the
  site's own controls on the Mac.
- Whether WebKit keeps a moved video playing is being checked with
  [the spike](#move-mode-spike). Chromium restarts a moved video; if Safari
  does the same on a site, the extension puts the video back and says so.
- Captions only when the site uses standard caption tracks.

## Install

Requires macOS with Safari 26 or later.

1. Safari ▸ Settings ▸ **Advanced**: turn on **Show features for web developers**.
2. Safari ▸ Settings ▸ **Developer**: turn on **Allow unsigned extensions**.
3. In the same tab, click **Add Temporary Extension…** and choose the
   `extension` folder.
4. Safari ▸ Settings ▸ **Extensions**: enable **Presenter Mode**. Allow it on
   the sites you want to use (or **on every website**). Safari also asks the
   first time you use it on a new site.
5. Reload any video tabs that were already open.

Safari removes temporary extensions when it quits or after 24 hours. "Allow
unsigned extensions" also resets when Safari quits. To pick up code changes,
click **Reload** next to the extension in Settings ▸ Extensions.

Recommended: Safari ▸ Settings ▸ **Websites** ▸ **Auto-Play** ▸ set the video
sites you use to **Allow All Auto-Play**. Without it, a new player window may
need one click before it plays with sound.

### Permanent install

A temporary extension disappears when Safari quits. To keep it installed,
build it into a small Mac app:

1. Install **Xcode** from the App Store and open it once to finish setup.
2. In Xcode ▸ Settings ▸ **Accounts**, add your Apple ID (a free account is
   enough). Then select it, click **Manage Certificates…**, and add an
   **Apple Development** certificate. Signed with it, the extension stays
   enabled across Safari restarts with "Allow unsigned extensions" off.
3. Run:

   ```bash
   npm run install:mac
   ```

   This converts the extension with `safari-web-extension-converter`, builds
   and signs the app, copies it to `~/Applications`, and opens it once so
   Safari registers the extension.
4. In Safari ▸ Settings ▸ Extensions, remove any temporary copy and enable
   **Presenter Mode**.

Run `npm run install:mac` again after changing the code.

If you skip step 2, the app is ad-hoc signed, and Safari only loads it while
"Allow unsigned extensions" is on.

## Apple TV setup

1. Control Center ▸ **Screen Mirroring** ▸ choose your Apple TV.
2. Set it to **Use As Separate Display**.
3. Optional: in System Settings ▸ Displays, give the TV a 1080p-class
   resolution. The Mac then has far fewer pixels to stream.

The first player window opens just to the right of your main screen. If the
TV is somewhere else, drag the window onto it once. The extension switches to
fullscreen and remembers that spot for next time.

## Usage

**Start** with the presenter button in YouTube's or Twitch's player controls
(next to fullscreen), **⌥⇧P**, or the toolbar popup.

**Remote bar:** title, play/pause, ±10 s, scrubber, speed, captions,
mute/volume, TV fullscreen, collapse and **End**. Live streams show LIVE
instead of a scrubber.

**Keyboard:** the usual YouTube shortcuts act on the TV while the controller
tab has focus, on any site:

| Key | Action |
|---|---|
| Space / K | Play / pause |
| J / L | Back / forward 10 s |
| ← / → | Back / forward 5 s |
| ↑ / ↓ | Volume |
| M | Mute |
| C | Captions |
| F | Fullscreen on the TV |
| < / > | Speed |
| 0–9 | Jump to 0–90% |
| Shift+N | Next video (YouTube) |

These keys are ignored while you type in a search box, a comment field or chat.

**Other behaviour:**
- **YouTube:** clicking another video, a Short or a live link in the
  controller plays it on the TV. Timestamp and chapter links in the
  description or comments move the TV too.
- **Twitch:** switching channel, or opening a past broadcast or clip, in the
  controller does the same. Chat stays usable on the Mac.
- **Any site:** seeking with the site's own player on the Mac moves the TV.
- If the TV display disconnects (the Apple TV sleeps, AirPlay drops), playback
  pauses instead of taking over the Mac screen.
- **End** closes the player and leaves the Mac tab paused at the TV's
  position.
- Closing the player window also ends presenter mode.
- Closing the controller tab leaves the player as a normal page.

## Diagnostics

Toolbar popup ▸ **Diagnostics** opens a live report. It's the first place to
look when something misbehaves. It covers:
- **Window placement and fullscreen:** the bounds the extension requested,
  where Safari placed the window, what each display reports, and whether
  window fullscreen worked without a click.
- **Background playback and sync:** gaps in player-to-controller updates,
  playback stalls, dropped frames and visibility changes. Each is timestamped,
  so you can line them up with what you were doing.
- **Command delivery:** how remote-bar commands reached the player, with
  Safari's error for any that needed a fallback.
- **Control paths:** a self-test that toggles captions, speed and play/pause
  three ways and records which ones work.
- **AirPlay route:** every connect and disconnect in AirPlay mode, with the
  context at the time.

**Copy report** copies everything as JSON.

## Development

```bash
npm install
```

```bash
npm test
```

`npm test` runs the quick unit tests. `npm run test:system` runs the
end-to-end scenarios (YouTube, Twitch, a generic site and a feed in move mode)
against simulated Safari and pages, including dropped messages, background
restarts, reloads and fullscreen failures; see [TESTING.md](TESTING.md).
`npm run check` syntax-checks every script. `npm run icons` redraws the icons.

### Move-mode spike

```bash
npm run spike
```

This serves a test page on http://localhost:8642/ (open it in Safari). It
moves a plain MP4 and a MediaSource video into a popup and records whether
they keep playing, show a picture and stay controllable, and what happens when
the page is hidden, reloaded or closed. The first run generates the test media
with AVFoundation (about 15 seconds). See [TESTING.md](TESTING.md#move-mode).

```
extension/
  manifest.json              Manifest V3
  background.js              session, window placement/fullscreen, message relay, diagnostics
  content/common.js          shared helpers, DOM builder, site registry, page-bridge client
  content/sites/youtube.js   YouTube adapter
  content/sites/twitch.js    Twitch adapter
  content/sites/generic.js   any other site with a <video>
  content/page-bridge.js     runs in YouTube's page context; wraps #movie_player's API
  content/player.js          player window: filling the TV, state reports, commands, overlays, AirPlay
  content/move.js            move mode: moves the page's own video into a TV window it opens
  content/controller.js      controller tab: presenter button, remote bar, key forwarding
  content/boot.js            picks the site adapter and the tab's role
  popup.*, diagnostics.*     toolbar popup and diagnostics page
  icons/
scripts/
  install-mac-app.sh         builds, signs and installs the Mac app (permanent install)
  make-icons.swift           icon generator
  make-spike-media.swift     test media for the move-mode spike
spike/move-video/            move-mode spike: test page and server (npm run spike)
tests/                       unit tests, system harness and scenarios (TESTING.md)
```

A site adapter says which URLs are playable and what the TV opens. It also
says how to find the video and what to blow up on the TV, plus where the
presenter button goes, how captions toggle, which prompts to dismiss, and how
to switch videos. Adding a site means adding one file to `content/sites/` and
listing it in the manifest.

On the TV, YouTube's player is resized with CSS. Twitch and generic sites have
their player lifted into the browser's top layer (the popover API), which
escapes any transform or stacking on the page.

YouTube enforces Trusted Types, so the content scripts build DOM nodes directly
and never assign `innerHTML`.

## Limitations

- Site markup changes can break the YouTube and Twitch adapters, for example
  YouTube's `.ytp-right-controls-right` or Twitch's
  `[data-a-target="video-player"]`.
- Generic sites: the TV opens the same page address, so it suits pages where
  the address identifies the video. In feeds (X, Reddit, Instagram) the TV may
  land on a different video; try [move mode](#move-mode-experimental), which
  has limits of its own. Players that only create their `<video>` after you
  click play need one click on the TV. Videos inside iframes aren't picked up
  yet.
- DRM services (Netflix, Disney+, Prime Video) will likely show black on an
  AirPlay display, or refuse a second stream.
- Opening a playlist link from the controller reloads the player page.
  Window fullscreen survives the reload, but autoplay has to be allowed for
  the site.
- If the player autoplays the next video, the controller page doesn't follow.
  The remote bar shows the new title.
- AirPlay mode depends on Safari keeping the stream routed to the Apple TV.
  Treat it as experimental.

## License

[MIT](LICENSE)
