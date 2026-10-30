#!/usr/bin/env python3
"""Prepare a personal-use device build using an external, version-pinned transport checkout."""
import argparse
import json
import pathlib
import shutil
import subprocess
import tempfile

TRANSPORT_COMMIT = "c8815c0b2ff9db3bcdaeeb75abb3ca0e42251efb"


def replace_once(path, old, new):
    text = path.read_text()
    if text.count(old) != 1:
        raise SystemExit(f"Unexpected transport source layout: {path.name}")
    path.write_text(text.replace(old, new))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--turbo-root", type=pathlib.Path, required=True)
    parser.add_argument("--staging-dir", type=pathlib.Path)
    parser.add_argument("--bundle-id", default="io.github.sany2ng.sublineglasses")
    args = parser.parse_args()
    external = args.turbo_root.resolve()
    revision = subprocess.check_output(["git", "-C", str(external), "rev-parse", "HEAD"], text=True).strip()
    if revision != TRANSPORT_COMMIT:
        raise SystemExit("Transport revision differs from the reviewed baseline; use a separate checkout at the pinned commit.")
    subprocess.run(["git", "-C", str(external), "diff", "--exit-code", "--quiet"], check=True)
    own = pathlib.Path(__file__).resolve().parents[1]
    commit = subprocess.check_output(["git", "-C", str(own), "rev-parse", "--short", "HEAD"], text=True).strip()
    staging = args.staging_dir.resolve() if args.staging_dir else pathlib.Path(tempfile.mkdtemp(prefix="subline-glasses-"))
    if staging.exists() and any(staging.iterdir()):
        raise SystemExit("Staging directory must be empty; no existing files are removed.")
    staging.mkdir(parents=True, exist_ok=True)
    components = ["apps/RayNeoCompanion", "core-probe/Sources", "core-probe/Frameworks",
                  "core-probe/RecoveredInterface", "core-probe/Vendor", "rayneo-protocol",
                  "rayneo-display", "rayneo-session", "rayneo-archive", "rayneo-audio-container",
                  "third-party/ZIPFoundation"]
    for name in components:
        shutil.copytree(external / name, staging / name,
                        ignore=shutil.ignore_patterns(".build", "build", "DerivedData", "*.xcodeproj"))
    # Emit declarations only for the current SDK. Placeholder bodies are never linked into the app.
    module = staging / "core-probe/RecoveredInterface/build/RayneoNet.swiftmodule/arm64-apple-ios.swiftmodule"
    module.parent.mkdir(parents=True, exist_ok=True)
    sdk = subprocess.check_output(["xcrun", "--sdk", "iphoneos", "--show-sdk-path"], text=True).strip()
    subprocess.run(["xcrun", "swiftc", "-emit-module", "-module-name", "RayneoNet",
                    "-target", "arm64-apple-ios26.0", "-sdk", sdk,
                    "-module-cache-path", str(staging / ".module-cache"),
                    str(staging / "core-probe/RecoveredInterface/RayneoNet.swift"),
                    "-emit-module-path", str(module)], check=True)
    notices = staging / "TransportNotices"
    notices.mkdir()
    for name in ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]:
        if (external / name).is_file():
            shutil.copy2(external / name, notices / name)
    app = staging / "apps/RayNeoCompanion"
    replace_once(app / "Sources/RayNeoCompanionApp.swift", "@main\nstruct RayNeoCompanionApp", "struct LegacyRayNeoCompanionApp")
    for file in (own / "Sources").glob("*.swift"):
        shutil.copy2(file, app / "Sources" / file.name)

    probe = staging / "core-probe/Sources/App.swift"
    replace_once(probe, "[13,14,15,20,21,22].contains(index)", "[13,14,15,19,20,21,22].contains(index)")
    replace_once(probe, "[162,166,168].contains(type)", "[2,162,166,168].contains(type)")
    replace_once(probe, "            self?.restoreStandbyIfRequested()", "            // This app never restores the companion voice workflow.")
    source = probe.read_text()
    start = source.index("            receiver.onVoiceEnvelope = {")
    end = source.index("            messageReceiver = receiver", start)
    source = source[:start] + "            receiver.onVoiceEnvelope = { _, _, _, _ in }\n" + source[end:]
    probe.write_text(source)
    receiver = staging / "core-probe/Sources/CoreMessageReceiver.swift"
    replace_once(receiver, "([14,15,20,21,22].contains(business) || alwaysOn)", "([13,14,15,19,20,21,22].contains(business) || alwaysOn)")

    spec = app / "project-device.yml"
    config = spec.read_text()
    config = config.replace('iOS: "16.0"', 'iOS: "26.0"')
    config = config.replace("PRODUCT_BUNDLE_IDENTIFIER: io.turboio.companion\n", f"PRODUCT_BUNDLE_IDENTIFIER: {args.bundle_id}\n")
    config = config.replace("PRODUCT_NAME: RayNeoCompanion", "PRODUCT_NAME: SublineGlasses")
    config = config.replace("CFBundleDisplayName: Turbo IO", f"CFBundleDisplayName: Subline Glasses\n        GlassesCommit: {commit}")
    config = config.replace('MARKETING_VERSION: "0.2.0"', 'MARKETING_VERSION: "0.1.0"')
    config = config.replace('CURRENT_PROJECT_VERSION: "2"', 'CURRENT_PROJECT_VERSION: "1"')
    config = config.replace("        UILaunchScreen: {}", "        UILaunchScreen: {}\n        NSSpeechRecognitionUsageDescription: 将眼镜传来的日语音频在手机本地识别为文字。\n        NSMicrophoneUsageDescription: 通过已连接的雷鸟蓝牙麦克风收音，不使用手机内置麦克风。")
    config = config.replace("UIBackgroundModes: [bluetooth-central, external-accessory]", "UIBackgroundModes: [bluetooth-central, external-accessory, audio]")
    spec.write_text(config)
    subprocess.run(["xcodegen", "generate", "--spec", str(spec)], check=True)
    result = {"project": str(app / "RayNeoCompanion.xcodeproj"), "scheme": "RayNeoCompanionDevice",
              "staging": str(staging), "bundleID": args.bundle_id, "sourceCommit": commit,
              "transportCommit": TRANSPORT_COMMIT}
    (staging / "glasses-build.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
