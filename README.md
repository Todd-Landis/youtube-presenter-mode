# YouTube Presenter Mode

A Safari extension that turns a YouTube tab into a two-screen setup. The video
plays fullscreen on your Apple TV, and the original tab on your Mac becomes a
remote control. Use other apps freely; playback stays on the TV.

Playback stays in Safari on the Mac, so the browser-side ad blocking you
already use keeps working. The Apple TV YouTube app doesn't get that.

## How it works

Starting presenter mode opens a second window, the **player**, at the current
timestamp. The original tab becomes the **controller**: its video pauses and
mutes, and a remote bar appears along the bottom.

There are two ways to get the picture to the TV. Choose one in the toolbar
popup:

| Mode | How it works |
|---|---|
| **Extended display** (default) | The player window goes fullscreen on the Apple TV, used as an AirPlay "Separate Display". |
| **AirPlay video** (experimental) | The player window stays on the Mac and AirPlays its video to the Apple TV. No extra desktop. |

## Install

Requires macOS with Safari 26 or later.

1. Safari ▸ Settings ▸ **Advanced**: turn on **Show features for web developers**.
2. Safari ▸ Settings ▸ **Developer**: turn on **Allow unsigned extensions**.
3. In the same tab, click **Add Temporary Extension…** and choose the
   `extension` folder.
4. Safari ▸ Settings ▸ **Extensions**: enable **YouTube Presenter Mode**, then
   set youtube.com to **Allow**.
5. Reload any YouTube tabs that were already open.

Safari removes temporary extensions when it quits or after 24 hours. "Allow
unsigned extensions" also resets when Safari quits. To pick up code changes,
click **Reload** next to the extension in Settings ▸ Extensions.

Recommended: Safari ▸ Settings ▸ **Websites** ▸ **Auto-Play** ▸ set youtube.com
to **Allow All Auto-Play**. Without it, a new player window may need one click
before it plays with sound.

### Permanent install

A temporary extension disappears when Safari quits. To keep it installed,
build it into a small Mac app:

1. Install **Xcode** from the App Store and open it once to finish setup.
2. In Xcode ▸ Settings ▸ **Accounts**, add your Apple ID. A free account is
   enough; it gives you an Apple Development certificate to sign with.
3. Run:

   ```bash
   npm run install:mac
   ```

   This converts the extension with `safari-web-extension-converter`, builds
   and signs the app, copies it to `~/Applications`, and opens it once so
   Safari registers the extension.
4. In Safari ▸ Settings ▸ Extensions, remove any temporary copy and enable
   **YouTube Presenter Mode**.

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

**Start** in any of three ways:
- the presenter button in YouTube's player controls (next to fullscreen)
- **⌥⇧P**
- the toolbar popup

**Remote bar:** title, play/pause, ±10 s, scrubber, speed, captions,
mute/volume, TV fullscreen, collapse and **End**.

**Keyboard:** the usual YouTube shortcuts act on the TV while the controller
tab has focus:

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
| Shift+N | Next video |

These keys are ignored while you type in the search box or a comment field.

**Other behaviour:**
- Clicking another video in the controller plays it on the TV.
- **End** closes the player and leaves the Mac tab paused at the TV's
  position.
- Closing the player window also ends presenter mode.
- Closing the controller tab leaves the player as a normal YouTube window.
- The player dismisses YouTube's "Continue watching?" prompt, so long videos
  and playlists don't pause on the TV.

## Diagnostics

Toolbar popup ▸ **Diagnostics** opens a live report. It's the first place to
look when something misbehaves. It covers:
- **Window placement and fullscreen:** the bounds the extension requested,
  where Safari placed the window, what each display reports, and whether
  window fullscreen worked without a click.
- **Background playback and sync:** gaps in player-to-controller updates,
  playback stalls, dropped frames and visibility changes. Each is timestamped,
  so you can line them up with what you were doing.
- **Control paths:** a self-test that toggles captions, speed and play/pause
  three ways (player API, YouTube's buttons, synthetic keys) and records which
  ones work.
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

The tests run the background logic against mocked extension APIs and the
content scripts in jsdom against a stubbed YouTube page. `npm run check`
syntax-checks every script. `npm run icons` redraws the icons.

```
extension/
  manifest.json            Manifest V3
  background.js            session, window placement/fullscreen, message relay, diagnostics
  content/common.js        shared helpers, DOM builder, page-bridge client
  content/page-bridge.js   runs in YouTube's page context; wraps #movie_player's API
  content/player.js        player window: fill-screen CSS, state reports, commands, overlays, AirPlay
  content/controller.js    controller tab: presenter button, remote bar, key forwarding
  content/boot.js          assigns each YouTube tab its role
  popup.*, diagnostics.*   toolbar popup and diagnostics page
  icons/
scripts/
  install-mac-app.sh       builds, signs and installs the Mac app (permanent install)
  make-icons.swift         icon generator
tests/
```

YouTube enforces Trusted Types, so the content scripts build DOM nodes directly
and never assign `innerHTML`.

## Limitations

- These depend on YouTube's markup and can break when YouTube changes it:
  `.ytp-right-controls-right`, `.ytp-subtitles-button`, `ytd-watch-metadata h1`
  and the "Continue watching?" dialog.
- Opening a playlist link from the controller reloads the player page.
  Window fullscreen survives the reload, but autoplay has to be allowed for
  youtube.com.
- If the player autoplays the next video, the controller page doesn't follow.
  The remote bar shows the new title.
- AirPlay mode depends on Safari keeping YouTube's stream routed to the Apple
  TV. Treat it as experimental.

## License

[MIT](LICENSE)
