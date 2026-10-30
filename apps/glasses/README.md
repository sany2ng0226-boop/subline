# Subline Glasses personal device candidate

A separate native iPhone entry point for Japanese speech from glasses, on-device recognition and translation, and Chinese-only glasses captions. The first device gate is two changing text frames in the original subtitle window, rather than notification cards.

This candidate does not include the vendor transport frameworks or Turbo IO sources. The preparation script stages a reviewed, separately acquired Turbo IO checkout at `c8815c0b2ff9db3bcdaeeb75abb3ca0e42251efb`, applies narrow host changes, and overlays this app. It does not modify that checkout, change glasses firmware, reset pairing, install an app, or invoke any cloud ASR service. The retained legacy UI is not instantiated.

The external checkout and vendor components retain their own licenses and restrictions. Turbo IO's current original sources use PolyForm Noncommercial 1.0.0; vendor frameworks have separate rights. This integration is a personal research candidate and is not a commercial distribution grant. The script preserves the dependency notices in staging. No dependency binaries, credentials, pairing records or device evidence belong in this directory.

```sh
python3 apps/glasses/scripts/prepare.py --turbo-root /path/to/reviewed/Turbo-IO --staging-dir /tmp/new-empty-glasses-build
```

Build the emitted Xcode project and `RayNeoCompanionDevice` scheme with an available personal development team and a separate DerivedData directory. The default bundle ID is `io.github.sany2ng.sublineglasses`; an explicit `--bundle-id` override is available for controlled local compatibility testing. The app displays its source commit from its Info.plist.

## Device acceptance boundaries

- Subtitle display uses business 19 and waits for the matching session ACK before sending text. SDK submission alone is not proof of lens rendering.
- The default microphone input is a verified RayNeo Bluetooth HFP route. The app refuses the phone's built-in microphone. A separate experimental option uses business 13 recorder control and 16 kHz mono Opus decoding; it must not run simultaneously with HFP capture. Coexistence with the subtitle window must be verified on the target firmware; business 19 microphone startup fields are not guessed.
- The phone microphone is never used. An absent glasses audio stream stops recognition with an explicit error.
- The Apple Japanese speech assets and Japanese–Chinese translation packs must already be installed. Translation and speech are processed natively, without relying on a WebView or silent-playback keep-alive.
- Bluetooth/external-accessory background declarations and the audio declaration for actual HFP capture do not prove long-running lock-screen support. Check incoming frames, translations, subtitle changes and stop behavior while genuinely locked. A short test does not establish ninety-minute reliability.

Diagnostics contain bounded counters, timestamps and foreground/protected-data state only, not audio or recognized text. They are stored in the app's private Documents folder for local device verification.
