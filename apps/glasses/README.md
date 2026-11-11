# Subline Glasses personal device candidate

A separate native iPhone entry point for Japanese speech captured by the phone, on-device recognition and translation, and bilingual glasses captions. The glasses show the latest Japanese recognition result above the latest completed Chinese translation; the default input is the iPhone's built-in microphone. Device acceptance requires changing text frames in the original subtitle window, rather than notification cards.

This candidate does not include the vendor transport frameworks or Turbo IO sources. The preparation script stages a reviewed, separately acquired Turbo IO checkout at `c8815c0b2ff9db3bcdaeeb75abb3ca0e42251efb`, applies narrow host changes, and overlays this app. It does not modify that checkout, change glasses firmware, reset pairing, install an app, or invoke any cloud ASR service. The retained legacy UI is not instantiated.

The external checkout and vendor components retain their own licenses and restrictions. Turbo IO's current original sources use PolyForm Noncommercial 1.0.0; vendor frameworks have separate rights. This integration is a personal research candidate and is not a commercial distribution grant. The script preserves the dependency notices in staging. No dependency binaries, credentials, pairing records or device evidence belong in this directory.

```sh
python3 apps/glasses/scripts/prepare.py --turbo-root /path/to/reviewed/Turbo-IO --staging-dir /tmp/new-empty-glasses-build
```

Build the emitted Xcode project and `RayNeoCompanionDevice` scheme with an available personal development team and a separate DerivedData directory. The default bundle ID is `io.github.sany2ng.sublineglasses`; an explicit `--bundle-id` override is available for controlled local compatibility testing. The app displays its source commit from its Info.plist.

## Use

The main screen shows a short state headline (with elapsed time while captions run, or the reason the last session stopped), a bilingual log and a single round start/cancel/stop action. Start only reconnects an existing binding, waits up to fifteen seconds for authenticated connection, requests a new subtitle session, and waits up to ten seconds for its matching ACK before beginning recognition and microphone capture. It never discovers or pairs a new device automatically. Cancel remains available during connection, subtitle confirmation and recognition preparation; a generation token prevents cancelled startup work from reopening capture.

Each log entry pairs a finalized Japanese sentence with its own completed Chinese translation, Japanese first; translations complete in finalization order, so phone entries are aligned sentence by sentence. Live Japanese that is still waiting for its translation appears dimmed below the log and may be revised as partial results stabilize. The log starts empty for each new session. Experimental input choices, first-time discovery/connection, display-only tests and counters are in the connection and diagnostics sheet behind the settings button. When an acknowledged static subtitle window is open and capture is idle, that section can send a fixed check-chat reminder through the existing session and lens-update throttle.

The lens requests the vendor's `font_size: 1` setting and up to five text lines without language labels. Rows are allocated to the content that is present rather than reserved for a language: long bilingual content uses up to two Japanese rows and three Chinese rows; short Japanese can leave one Japanese row and four Chinese rows, while short Chinese leaves more rows for Japanese. A single language can use all five rows, and empty input does not create blank placeholder rows. Every line is limited to 20 grapheme clusters and 75 UTF-8 bytes, and the complete frame stays below the app's self-imposed 384-byte budget. Earlier Japanese is omitted as the live result grows; Chinese that does not fit ends with `…`, and the phone notes that the lens showed only the beginning. The phone log keeps every complete sentence and translation of the session.

There is no automatic paging or translation display queue: each newly completed Chinese translation replaces the previous one, while lens updates continue to use the bounded, duplicate-suppressing throttle. Stop cancels pending lens work, and opening a new subtitle session starts with empty display state.

The requested font setting's visual size, five-row visibility and last-column fit remain device acceptance items. `font_size: 1` is a request to the vendor window, not proof that it is the smallest supported or rendered size. The diagnostics sheet provides a five-row capacity probe with a visible marker at the end of every row, but the probe and configuration values do not replace visual confirmation through the target lenses.

## Device acceptance boundaries

- Subtitle display uses business 19 and waits for the matching session ACK before sending combined Japanese and Chinese text. SDK submission alone is not proof of lens rendering.
- The default input is a strictly verified iPhone built-in microphone route. It does not silently choose a Bluetooth headset. RayNeo Bluetooth HFP and business 13 recorder control with 16 kHz mono Opus decoding remain explicitly experimental, separate input options. Only one input runs at a time; an absent stream stops recognition with an explicit error.
- Coexistence of either experimental glasses microphone option with the subtitle window must be verified on the target firmware; business 19 microphone startup fields are not guessed.
- The Apple Japanese speech assets and Japanese–Chinese translation packs must already be installed. Translation and speech are processed natively, without relying on a WebView or silent-playback keep-alive.
- The audio background declaration is for actual microphone capture, never silent playback. It and the Bluetooth/external-accessory declarations do not prove long-running lock-screen support. Check incoming frames, translations, subtitle changes and stop behavior while genuinely locked; short tests do not establish long-session reliability.
- Launching explicitly with `--subline-glasses-fixture` feeds a validated `subline-glasses-fixture.wav` from the app's private Documents folder to the same Apple recognition and translation pipeline in real time, without speaker playback. The fixture must be PCM16, 16 kHz and mono, and no longer than ten minutes. Normal launches keep the production microphone input path unchanged. This mode exists to collect repeatable lock-screen evidence; it does not by itself establish that recognition, translation or lens updates continue while locked.

Diagnostics contain bounded counters, timestamps and foreground/protected-data state only, not audio or recognized text. They are stored in the app's private Documents folder for local device verification.
