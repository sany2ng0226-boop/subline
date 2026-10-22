# Subline Dev macOS variant

`Subline Dev` is a locally packaged macOS variant that can be installed and run beside the release `Subline.app`. The release packaging path and identity remain unchanged.

## Development workflow

1. Quit the installed **Subline Dev** before running `pnpm dev` from the repository root. It delegates to `SUBLINE_VARIANT=dev electron-vite dev --watch`: source development uses the Dev identity and profile, with renderer hot reload and main/preload rebuilds on edits, without deploy, packaging or signing. The installed Dev and source Dev share a single-instance lock; release Subline remains separate.
2. Iterate in source development, then consolidate the checks relevant to the changed modules. Run the required quality gate once the changes settle, avoiding duplicate checks already covered by that gate.
3. Quit source Dev, then run `pnpm --filter @rt/macos dist:dev:dir` for one final signed Dev app and install it for acceptance. This command already builds the source; do not run `pnpm build` immediately beforehand.
4. In the installed app, reproduce the original issue and check key persistence across restart, native interactions and release isolation. A packaged app is still required for final macOS system-audio, permission and integration QA; source development and automated tests do not replace it.
5. Apply the same verified changes to the formal app only within Jack's authorization, then capture screenshots of the final accepted state.

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

The Dev directory build is signed without notarization and is intended for local validation. Installed application interactions and isolation from the release app must be checked separately from automated tests.
