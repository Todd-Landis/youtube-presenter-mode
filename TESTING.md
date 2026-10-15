# Testing

Three layers, from fast to thorough:

| Command | What it covers | Time |
|---|---|---|
| `npm test` | Unit tests: background logic against mocked extension APIs, content scripts in jsdom | ~10 s |
| `npm run test:system` | 33 end-to-end scenarios plus a fuzzer, against simulated Safari and YouTube | ~3 min |
| Manual checklist below | The things only real Safari and a real Apple TV can show | ~10 min |

## The system harness

`tests/harness.mjs` runs the real `background.js` and content scripts together:
- A simulated Mac YouTube tab and a simulated TV window, each a fake YouTube page with a working player. It has a playback clock, autoplay rules, SPA navigation, Shorts, and live and broken videos.
- They're wired through a simulated Safari extension layer that can be made to misbehave:
  - drop or delay messages in either direction, or lose replies
  - unload the background page mid-session (in-memory state lost, storage kept)
  - report new windows as `about:blank` first, or open them away from the requested position
  - ignore `windows.update({state: "fullscreen"})`, always or while the page is loading
  - fail to load the page-world bridge, as Safari ignores the manifest's `world` key
  - close tabs, reload pages, disconnect the TV display, or have the user leave fullscreen

`tests/system.test.mjs` holds the scenarios. Each one describes the expected behaviour, so a failure is a real regression.

The fuzzer drives random use (clicks, shortcuts, video switches, timestamp links, reloads, background restarts, message loss) and then checks a set of invariants:
- exactly one TV window
- the bar's play state and title match the TV
- the Mac copy of the video is silent
- End cleans everything up

```bash
FUZZ_SEEDS=1,2,3,4,5 npm run test:system -- fuzz
```

```bash
FUZZ_BRIDGE=0 FUZZ_SEEDS=6,7,8 npm run test:system -- fuzz
```

Pass part of a scenario name to run just that one, e.g. `npm run test:system -- playlist`.

## Holes found and fixed

Found by reading the code, by checking real YouTube behaviour in a browser, and by running the scenarios against the code as it was. Before the fixes, every scenario failed: the about:blank problem below ended the session at startup.

### Connections

| Problem | Effect | Fix |
|---|---|---|
| A new window reporting `about:blank` (or a consent page on a youtube.com subdomain) counted as "the TV window left YouTube" | Session ended at once; the Mac tab was stuck on "connecting" | Only real http(s) pages outside `*.youtube.com` count as leaving |
| The "session ended" notice could arrive before the start reply | Mac tab entered presenter mode for a dead session | The Mac tab remembers ended sessions and ignores them |
| A state report still in flight when End was pressed | Remote bar came back after End | Same: reports for ended sessions are ignored |
| Messages from the Mac tab to the extension weren't retried | A command, a start or an End could vanish silently; End could hide the bar while the TV kept playing | Commands, start and End are retried. Commands carry IDs and the TV skips repeats; start and End are safe to repeat |
| A queued command and a later direct one | The later one could run first (a pause landing after a play) | Once a command is queued, the following ones queue behind it |
| Two commands collected from the queue together ran at the same time | A pause's "did it hold?" check undid the play after it | The TV runs commands one at a time. The pause check no longer blocks the queue and is cancelled by a later play |
| Commands arriving out of order | An older play/pause, seek or setting could win | Commands carry increasing sequence numbers; for absolute settings the TV skips anything older than what it already applied |
| Commands sent while the TV page was still loading | Answered "unknown command" and showed an error | The TV says "not ready"; the command is queued and runs on its first report |
| The TV skipped a status report while another was in flight | Right after start, or after play/pause, the bar lagged by up to half a second (clicking then did the opposite of what you expected) | A skipped report runs right after the current one |
| The TV waited for the page-world bridge before starting | Up to 2.4 s of dead time on every TV page load in Safari | The TV starts at once and uses the bridge when it arrives |

### Starting and ending

| Problem | Effect | Fix |
|---|---|---|
| Double-click on the presenter button | Could open two TV windows, or start and immediately end | One start at a time; a repeated start returns the same session; End is ignored in the first second |
| Play/pause pressed before the TV's first report | Resolved against a stale "paused" and came out as play | A TV that was just started is about to play, so the press means pause |
| A pause sent while the TV page was loading | YouTube's autoplay, or our own initial play, overrode it | The initial play runs through the command queue, and a pause from you wins over autoplay for the first seconds |

### Reloads and switching videos

| Problem | Effect | Fix |
|---|---|---|
| Reloading the TV page | Jumped back to where presenter mode first started | The extension keeps the TV's recent position and resumes from it |
| The TV autoplays the next video, then reloads | Seeked the new video to the old video's position | The session follows the TV's current video |
| Opening a Short in the Mac tab | The Short played with sound on the Mac; nothing changed on the TV | Shorts and `/live/` links go to the TV; any video in the Mac tab stays silent |
| Clicking a timestamp or chapter link in the Mac tab | Moved only the paused Mac copy | The seek is passed on to the TV (ignoring YouTube's own seeks while a page loads) |
| A link with `&t=1m30s` | Started at 0 | `t=` and `start=` are honoured in all their formats |
| `yt-navigate-finish` firing twice for one navigation | Could load the video twice | Repeats within 2 s are ignored |
| Live streams | Duration shows as `NaN` or as years; the scrubber and 0–9 keys misbehaved | Shown as LIVE; scrubber and percentage seeks disabled |
| Unplayable videos (YouTube only reports these as an error code in its player API) | Nothing on the Mac said why the TV was blank | The bar shows "The TV can't play this video (reason)" |

### Fullscreen

| Problem | Effect | Fix |
|---|---|---|
| If you left fullscreen on the TV, the auto-retry could put it back within 4 s | Fighting the user | Leaving fullscreen yourself is detected and respected; F on the remote turns it back on |
| A playlist link reloads the TV page and loses element fullscreen | TV stayed windowed | Each new TV page gets a fresh set of fullscreen attempts, unless you turned fullscreen off |
| The TV only reported its size twice a second | Fullscreen changes were noticed late | The TV reports immediately on resize |
| The Apple TV sleeps or AirPlay drops while playing | macOS moved the TV window to the Mac screen, still fullscreen and playing | Playback pauses, the window leaves fullscreen, and the remote says the TV disconnected |

### Keyboard

| Problem | Effect | Fix |
|---|---|---|
| Holding Space or K | Play/pause flickered on every key repeat | Only seek and volume keys repeat |
| Typing with an input method (e.g. Japanese) | Composition keystrokes could control the TV | Ignored while composing |

## What the simulation can't prove

The harness models Safari as closely as I could. Real Safari still decides these, so they need the manual check:
- whether Safari reports `about:blank` for new windows, and whether it honours `windows.update({state: "fullscreen"})` (the code now works either way)
- which bridge path loads in Safari (manifest, script tag or scripting API), or none. Diagnostics ▸ Control paths shows it
- AirPlay route behaviour (not simulated)
- YouTube's real markup, which can change. Checked against the live site: the play button's "Pause"/"Play" label, Shorts using `#shorts-player`, `loadVideoById` leaving the page URL unchanged, live durations, and error codes

One fuzz run reported an error that didn't reproduce in ten reruns of the same seeds. The error could only come from code running in a simulated page the harness had already closed.

## Manual checklist (real Safari, real TV)

After `npm run install:mac`, close any old TV window and reload YouTube tabs. Then:

1. Start from the presenter button. The TV goes fullscreen without a click.
2. Pause and play from the bar and with K/Space. Click several times quickly: the TV ends up in the state the bar shows.
3. J/L, arrows, 0–9, C, < >, M: all act on the TV.
4. Click a different video in the Mac tab: it plays on the TV, and the Mac stays silent.
5. Click a timestamp in the description or comments: the TV jumps there.
6. Open a Short in the Mac tab: it plays on the TV.
7. Press F twice on the Mac: the TV leaves and re-enters fullscreen. Then press Esc or ⌃⌘F on the TV: it stays windowed.
8. Reload the TV window (⌘R on it): it resumes where it was.
9. Reload the Mac tab: the bar comes back and works.
10. Put the Apple TV to sleep (or stop AirPlay) mid-video: playback pauses and the remote says so.
11. Press End: the TV window closes; the Mac tab is parked at the TV's position. Nothing comes back.

If anything misbehaves: Toolbar ▸ Diagnostics ▸ **Copy report**.
