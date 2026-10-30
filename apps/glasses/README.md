# Subline Glasses personal device candidate

A separate native iPhone entry point for Japanese speech captured by the phone, on-device recognition and translation, and Chinese-only glasses captions. The glasses are the display; the default input is the iPhone's built-in microphone. Device acceptance requires changing text frames in the original subtitle window, rather than notification cards.

This candidate does not include the vendor transport frameworks or Turbo IO sources. The preparation script stages a reviewed, separately acquired Turbo IO checkout at `c8815c0b2ff9db3bcdaeeb75abb3ca0e42251efb`, applies narrow host changes, and overlays this app. It does not modify that checkout, change glasses firmware, reset pairing, install an app, or invoke any cloud ASR service. The retained legacy UI is not instantiated.

The external checkout and vendor components retain their own licenses and restrictions. Turbo IO's current original sources use PolyForm Noncommercial 1.0.0; vendor frameworks have separate rights. This integration is a personal research candidate and is not a commercial distribution grant. The script preserves the dependency notices in staging. No dependency binaries, credentials, pairing records or device evidence belong in this directory.

```sh
python3 apps/glasses/scripts/prepare.py --turbo-root /path/to/reviewed/Turbo-IO --staging-dir /tmp/new-empty-glasses-build
```

Build the emitted Xcode project and `RayNeoCompanionDevice` scheme with an available personal development team and a separate DerivedData directory. The default bundle ID is `io.github.sany2ng.sublineglasses`; an explicit `--bundle-id` override is available for controlled local compatibility testing. The app displays its source commit from its Info.plist.

## Use

The main screen shows the connection state, a single start/cancel/stop action, and the complete current Chinese translation. Start only reconnects an existing binding, waits up to fifteen seconds for authenticated connection, requests a new subtitle session, and waits up to ten seconds for its matching ACK before beginning recognition and microphone capture. It never discovers or pairs a new device automatically. Cancel remains available during connection, subtitle confirmation and recognition preparation; a generation token prevents cancelled startup work from reopening capture.

Original text, experimental input choices, first-time discovery/connection, display-only A/B tests and counters are in the initially collapsed diagnostics section. Stop preserves native pipeline tail text on the phone while preventing further lens updates and requesting exit from the owned subtitle session.

Each lens update is limited to 384 UTF-8 bytes, including an explicit `…（未完）` suffix when the complete translation exceeds that limit. The main screen retains the full translation and shows that lens display is incomplete. This candidate does not page or queue undisplayed remainder; the suffix is an incompleteness warning, not a claim that all text was shown.

## Device acceptance boundaries

- Subtitle display uses business 19 and waits for the matching session ACK before sending text. SDK submission alone is not proof of lens rendering.
- The default input is a strictly verified iPhone built-in microphone route. It does not silently choose a Bluetooth headset. RayNeo Bluetooth HFP and business 13 recorder control with 16 kHz mono Opus decoding remain explicitly experimental, separate input options. Only one input runs at a time; an absent stream stops recognition with an explicit error.
- Coexistence of either experimental glasses microphone option with the subtitle window must be verified on the target firmware; business 19 microphone startup fields are not guessed.
- The Apple Japanese speech assets and Japanese–Chinese translation packs must already be installed. Translation and speech are processed natively, without relying on a WebView or silent-playback keep-alive.
- The audio background declaration is for actual microphone capture, never silent playback. It and the Bluetooth/external-accessory declarations do not prove long-running lock-screen support. Check incoming frames, translations, subtitle changes and stop behavior while genuinely locked; short tests do not establish long-session reliability.

Diagnostics contain bounded counters, timestamps and foreground/protected-data state only, not audio or recognized text. They are stored in the app's private Documents folder for local device verification.
