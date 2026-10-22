# Subline Dev macOS variant

`Subline Dev` is a locally packaged macOS variant that can be installed and run beside the release `Subline.app`. The release packaging path and identity remain unchanged.

## Packaging

- `pnpm --filter @rt/macos dist:dev` builds a signed app and DMG.
- `pnpm --filter @rt/macos dist:dev:dir` builds the signed app directory only.
- Both commands use app ID `io.github.sany2ng0226.classroomtranslator.dev`, product name `Subline Dev`, and always write to `apps/macos/release-dev/`. `RT_RELEASE_DIR` is ignored for this variant.
- Dev packaging sets `CSC_NAME="JIANG ZIYANG (R9LRJU53ZG)"`, requires code signing, and disables notarization.
- `SUBLINE_VARIANT=dev` is compiled into the Electron main process. The generated package metadata also identifies the dev variant.
- The icon generator derives `build/icon-dev.png` and `build/icon-dev.icns` from the shared SVG and adds a visible red `DEV` badge. It does not replace the release icon assets.

## Runtime isolation

The dev variant sets its application name and `userData` directory before requesting the single-instance lock. Its profile is `<appData>/Subline Dev`, so release and dev can run at the same time with separate instance locks.

All profile data stays under that directory, including `settings.json`, `recovery.json`, `archives.json`, and `archive-library.json`. Legacy migration from `Classroom Translator Internal` or `@rt/macos` is skipped, so dev never copies release data.

Downloaded ASR models and the writable Transformers cache live under `<appData>/Subline Dev/models/`, including `models/transformers/`. Keeping this cache separate prevents release and dev from writing or deleting the same model files concurrently.

Subline Dev always registers `Alt+Shift+Command+R` for recording, even if its saved settings contain another accelerator. Release continues to use its configured shortcut, whose macOS default is `Alt+Command+R`.

## Verification boundary

Packaging, signing, and simultaneous-launch verification are performed manually by the package owner; the automated implementation work does not run those steps.
