# macOS notarization

`apps/macos/electron-builder.yml` deliberately leaves `mac.notarize` unset.
No hooks or packaging steps are added. With no notarization environment variables,
the existing build and manual signing/notarization workflow behave as before.
`hardenedRuntime`, `entitlements`, and `entitlementsInherit` are unchanged.

## Version and automatic behavior

At this change, `apps/macos/node_modules/electron-builder/package.json` was absent,
so an installed version could not be verified. `apps/macos/package.json` requests
`^25.1.8` and `pnpm-lock.yaml` resolves electron-builder and app-builder-lib to
25.1.8. After dependencies are installed, check from the repository root:

```sh
node -p "require('./apps/macos/node_modules/electron-builder/package.json').version"
node apps/macos/scripts/check-notarize-env.mjs
```

The [25.1.8 implementation](https://github.com/electron-userland/electron-builder/blob/electron-builder%4025.1.8/packages/app-builder-lib/src/macPackager.ts)
(`notarizeIfProvided` / `getNotarizeOptions`) confirms environment-driven
notarization when `mac.notarize` is unset, after signing a non-MAS app.
`false` explicitly disables it; setting `true` is unnecessary. Recheck these
semantics when upgrading. Automatic notarization needs valid signing as well as
notarization credentials; credentials alone do not make an unsigned build notarizable.

## Credentials

Provide one complete option through your existing secure environment injection.
Never store passwords, private keys, or credential values in this repository.

| Option | Required environment variables | Meaning |
| --- | --- | --- |
| Apple ID | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Developer Apple ID, app-specific password (not the login password), developer team ID. |
| App Store Connect API key | `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | `APPLE_API_KEY` is the path to the private `.p8` file stored outside the repo; the others identify the key and issuer. |
| Existing Keychain profile | `APPLE_KEYCHAIN_PROFILE` | Previously stored notarytool credentials; optional `APPLE_KEYCHAIN` selects a keychain. |

25.1.8 checks Apple ID/password first, API credentials second, Keychain profile
third. Partial Apple ID/password or API sets can throw instead of falling back
to another option. `APPLE_TEAM_ID` alone does not trigger the Apple ID branch;
`APPLE_KEYCHAIN` alone does not configure a profile. Avoid mixing options.

The standalone check script only reports the selected set and missing variable
names. It never prints values, reads key files, validates credentials, contacts
Apple, signs, or notarizes. It always exits 0, including for incomplete sets;
it is informational and is not wired into packaging.

## Keeping manual signing and notarization

Continue using the existing packaging, manual `codesign`, `xcrun notarytool`,
and stapling procedure. Keep notarization variables out of the packaging process
when submission is intended to happen manually afterward. If credentials must
remain in that environment, an explicit electron-builder invocation can use
`-c.mac.notarize=false` for that run; do not persist that override in the YAML.
The existing `CSC_IDENTITY_AUTO_DISCOVERY=false` unsigned-build option controls
signing, not notarization credentials.

After manual submission, require an Accepted result, staple the intended app or
DMG as appropriate, and validate the final distributed artifact with stapler and
Gatekeeper. This placeholder does not submit or verify a real release.

## Entitlements review

Both the app and inherited helpers currently use
`apps/macos/build/entitlements.mac.plist`. These are runtime permissions, not
notarization credentials. This change preserves all four:

| Entitlement (`com.apple.security.*`) | Needed? |
| --- | --- |
| `cs.allow-jit` | Yes for Electron/V8 JIT under hardened runtime; retain. |
| `cs.allow-unsigned-executable-memory` | Conditional compatibility exception for runtimes/native components needing executable memory outside the JIT mechanism. Not proven necessary for the current Electron/native bundle; retain pending signed-build ASR/translation tests without it. |
| `cs.disable-library-validation` | Conditional: needed when loading native libraries that fail normal same-team/Apple signature validation. The existing plist cites sherpa-onnx/onnxruntime libraries. Could be unnecessary if every shipped native library is properly signed with the same team; this has not been verified, so retain. |
| `device.audio-input` | Yes for microphone recording under hardened runtime; retain. It does not replace the microphone usage description or user consent. |

Removing conditional exceptions requires a separate signed-artifact audit and
runtime validation covering microphone/system audio, ASR and local translation.
