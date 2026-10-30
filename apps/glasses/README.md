# Subline Glasses personal device candidate

A separate native iPhone entry point for Japanese speech captured by the phone, on-device recognition and translation, and bilingual glasses captions. The glasses show the latest Japanese recognition result above the latest completed Chinese translation; the default input is the iPhone's built-in microphone. Device acceptance requires changing text frames in the original subtitle window, rather than notification cards.

This candidate does not include the vendor transport frameworks or Turbo IO sources. The preparation script stages a reviewed, separately acquired Turbo IO checkout at `c8815c0b2ff9db3bcdaeeb75abb3ca0e42251efb`, applies narrow host changes, and overlays this app. It does not modify that checkout, change glasses firmware, reset pairing, install an app, or invoke any cloud ASR service. The retained legacy UI is not instantiated.

The external checkout and vendor components retain their own licenses and restrictions. Turbo IO's current original sources use PolyForm Noncommercial 1.0.0; vendor frameworks have separate rights. This integration is a personal research candidate and is not a commercial distribution grant. The script preserves the dependency notices in staging. No dependency binaries, credentials, pairing records or device evidence belong in this directory.

```sh
python3 apps/glasses/scripts/prepare.py --turbo-root /path/to/reviewed/Turbo-IO --staging-dir /tmp/new-empty-glasses-build
```

Build the emitted Xcode project and `RayNeoCompanionDevice` scheme with an available personal development team and a separate DerivedData directory. The default bundle ID is `io.github.sany2ng.sublineglasses`; an explicit `--bundle-id` override is available for controlled local compatibility testing. The app displays its source commit from its Info.plist.

## Use

The main screen shows the connection state, a single start/cancel/stop action, the current Japanese recognition result and the latest completed Chinese translation. Start only reconnects an existing binding, waits up to fifteen seconds for authenticated connection, requests a new subtitle session, and waits up to ten seconds for its matching ACK before beginning recognition and microphone capture. It never discovers or pairs a new device automatically. Cancel remains available during connection, subtitle confirmation and recognition preparation; a generation token prevents cancelled startup work from reopening capture.

Japanese text follows Apple's live recognition results and may be revised as partial results stabilize. Chinese changes only when a translation finishes, so the two sections do not guarantee sentence-level alignment. Experimental input choices, first-time discovery/connection, display-only A/B tests and counters are in the initially collapsed diagnostics section. Stop preserves native pipeline tail text on the phone while cancelling pending lens updates and requesting exit from the owned subtitle session; opening a new subtitle session starts with an empty display cache.

Lens updates use a leading-edge throttle with the latest pending frame sent at the trailing edge, producing at most one changed frame every 0.5 seconds rather than waiting for a pause in speech. Duplicate frames are suppressed. Each frame is limited to 384 UTF-8 bytes: the Japanese section keeps a trailing window within 112 bytes and adds a leading `…` when earlier text is omitted, while Chinese uses the remaining budget and adds `…（未完）` if its ending is omitted. The phone retains the complete current Japanese result and translation. The candidate does not page or queue undisplayed remainder.

## Device acceptance boundaries

- Subtitle display uses business 19 and waits for the matching session ACK before sending combined Japanese and Chinese text. SDK submission alone is not proof of lens rendering.
- The default input is a strictly verified iPhone built-in microphone route. It does not silently choose a Bluetooth headset. RayNeo Bluetooth HFP and business 13 recorder control with 16 kHz mono Opus decoding remain explicitly experimental, separate input options. Only one input runs at a time; an absent stream stops recognition with an explicit error.
- Coexistence of either experimental glasses microphone option with the subtitle window must be verified on the target firmware; business 19 microphone startup fields are not guessed.
- The Apple Japanese speech assets and Japanese–Chinese translation packs must already be installed. Translation and speech are processed natively, without relying on a WebView or silent-playback keep-alive.
- The audio background declaration is for actual microphone capture, never silent playback. It and the Bluetooth/external-accessory declarations do not prove long-running lock-screen support. Check incoming frames, translations, subtitle changes and stop behavior while genuinely locked; short tests do not establish long-session reliability.

Diagnostics contain bounded counters, timestamps and foreground/protected-data state only, not audio or recognized text. They are stored in the app's private Documents folder for local device verification.
