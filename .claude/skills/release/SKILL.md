---
name: release
description: 发布/重发 Subline（原 Realtime Translator）的 release（macOS dmg + web 自动部署）。当用户说「发布」「重新发布」「打包发版」「重发 release」时使用。
---

# Release 流程

本仓库的发布物有两个，**一次 push 会同时影响两者**：

- **macOS dmg**：手动打包后上传到 GitHub Release 资产。
- **Web PWA**：push 到 `main` 后由 `.github/workflows/ci.yml` 的 `deploy-web` job 部署到 GitHub Pages，**且仅在 check job 全绿后执行**（坏代码进不了线上）。发 macOS 版前仍需确认 main 上没有「不想同时上线 web」的改动。

## 1. 发布前检查（必须全绿才继续）

```bash
git status --porcelain          # 工作树必须干净
pnpm check                      # core 测试 + 三端 type-check（与 CI 的 check job 完全一致）
```

本地过了，push 后 CI 必绿、web 部署才会放行。

## 2. 版本号

- **版本源**：根 `package.json`；`apps/*` 与 `packages/*` 的 `version` 与根保持一致，统一用脚本同步，不要手改。三端设置页展示的 `__APP_VERSION__` 与 macOS dmg/App 版本均在构建期注入。
- **新版本**：

  ```bash
  node scripts/sync-version.mjs --set <ver> --write   # 改根与各包共 6 个 package.json
  node scripts/sync-version.mjs --check
  ```

  用 `chore: bump version to <ver>` 提交。同时在 `CHANGELOG.md` 加该版本一节（发布前标「准备中」，发布后改日期），并把中英 README 的下载链接改到新 tag。
- **beta 同版本重发**：版本号不动。构建之间靠「根版本+commit 短哈希」区分（构建期注入 `__APP_VERSION__`，设置页底部可见）。

## 3. 打包 macOS

```bash
# 去掉环境里的公证变量，避免 electron-builder 自动公证；用 Developer ID 签名
env -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD -u APPLE_API_KEY -u APPLE_KEYCHAIN_PROFILE \
  CSC_NAME="JIANG ZIYANG (R9LRJU53ZG)" pnpm --filter @rt/macos dist   # 产物在 apps/macos/release/
```

打包要几分钟，放后台跑；不要和其他重任务（如视频渲染）同时跑大内存流程。

注意事项：

- 打包脚本（`scripts/package-mac.mjs`）会把工程同步到 `.deploy-macos/` 自包含副本后在那里跑 electron-builder——日志里显示加载的是 `.deploy-macos/electron-builder.yml` 属正常，配置源头仍是 `apps/macos/electron-builder.yml`。
- **产物核验**（每次必做）：

  ```bash
  plutil -p "apps/macos/release/mac-arm64/Subline.app/Contents/Info.plist" \
    | grep -E "UsageDescription|CFBundleShortVersion"
  ```

  必须包含 `NSMicrophoneUsageDescription` 与 `NSAudioCaptureUsageDescription`（系统音频采集依赖后者，缺失会得到不弹窗、无报错的静音流）。
- **签名核验**：`codesign --verify --deep --strict` 通过，且 app 与 `Contents/Resources/apple-speech` 的 Authority 都是 `Developer ID Application: JIANG ZIYANG (R9LRJU53ZG)`。`electron-builder.yml` 的 `mac.binaries` 路径必须写 `Contents/Resources/...`（beta.8 曾因少写 `Contents/` 签名失败）。
- 模型不打进包（运行时按需下载）；打包版模型目录在 `userData` 下，与 dev 的 `apps/macos/models/` 不共享。

## 3.5 公证（每个新包都要重新做，不能沿用旧包结果）

本机 Keychain 已存 notarytool 凭据，profile 名 `subline-notary`。先公证 app，钉票据；再用钉好票据的 app 重做 DMG，签名后单独公证 DMG：

```bash
cd apps/macos/release && R=<ver> && mkdir -p $R
ditto -c -k --keepParent mac-arm64/Subline.app $R/Subline-app.zip
xcrun notarytool submit $R/Subline-app.zip --keychain-profile subline-notary --wait   # 必须 Accepted
xcrun stapler staple mac-arm64/Subline.app && spctl -a -vvv -t exec mac-arm64/Subline.app

D=$R/Subline-<ver>-arm64-notarized.dmg
mkdir $R/stage && ditto mac-arm64/Subline.app $R/stage/Subline.app && ln -s /Applications $R/stage/Applications
hdiutil create -volname "Subline <ver>" -srcfolder $R/stage -ov -format UDZO -fs HFS+ $D
codesign --sign "Developer ID Application: JIANG ZIYANG (R9LRJU53ZG)" --timestamp $D
xcrun notarytool submit $D --keychain-profile subline-notary --wait                   # 必须 Accepted
xcrun stapler staple $D && spctl -a -vvv -t open --context context:primary-signature $D
rm -rf $R/stage $R/Subline-app.zip
(cd $R && shasum -a 256 $(basename $D) > SHA256SUMS)
```

公证都在后台跑，各需几分钟。electron-builder 自己产出的 `Subline-<ver>-arm64.dmg` 里是未钉票据的 app，不要上传它。

## 3.6 本机试装

上传前先备份现有 `/Applications/Subline.app`（如 `release/<旧版本>/Subline-<旧版本>-installed.app`），从公证 DMG 装新版，启动确认无崩溃，再请 Jack 实际试录、开关翻译、归档回放。Jack 试过再发布。

## 4. 发布

### beta 同版本重发（覆盖既有 release）

```bash
git push origin main
git tag -f v<ver> && git push -f origin v<ver>
gh release upload v<ver> \
  "apps/macos/release/Subline-<ver>-arm64.dmg" \
  "apps/macos/release/Subline-<ver>-arm64.dmg.blockmap" --clobber
```

- 约定：**不 revert、不留版本号往返提交**，tag 直接强推到新 commit。
- GitHub 会把资产名里的空格替换为点（`Realtime.Translator-...`），`--clobber` 按替换后的名字正常覆盖。

### 新版本

```bash
git push origin main
git tag v<ver> && git push origin v<ver>
gh release create v<ver> --prerelease --title "Subline <ver> · Apple Silicon 测试版" --notes-file <notes.md> \
  "apps/macos/release/<ver>/Subline-<ver>-arm64-notarized.dmg" \
  "apps/macos/release/<ver>/SHA256SUMS"
```

- beta 阶段用 `--prerelease`。
- 先在功能分支上提交文档、版本号和修复，打包公证用的就是分支 HEAD；Jack 同意发布后 `git merge --ff-only` 快进到 main 再推，保证 tag 指向打包时的那个提交。
- 发布说明按「本次更新 / 安装 / 验证范围」写，验证范围如实写明未验收项（长时间录音、低内存机型等），末尾写构建来源 commit。
- 只改文档的推送，CI 会跳过 web 部署，这是正常的。

## 5. 发布后确认

```bash
gh run list --branch main --limit 2       # CI 与 web 部署均 success
gh release view v<ver> --json assets -q '.assets[] | "\(.name)  \(.size)  \(.updatedAt)"'
```

资产的 `updatedAt` 应为刚才的上传时间（重发时用它确认覆盖成功）。

## 模型资产（models-v1）

新模型（识别 / 本地翻译）上架步骤：

1. **上传资产**：资产按 `<模型id>-<原文件名>` 扁平命名（公共依赖 Silero VAD 无前缀，直接 `silero_vad.onnx`），全部上传到同一 `models-v1` release：

   ```bash
   gh release upload models-v1 <files> --clobber
   ```

2. **登记注册表**（`packages/core`：统一清单在 `model-registry.ts`，下载源治理在 `model-sources.ts`；ASR 视图见 `models.ts`、翻译视图见 `translation/local-spec.ts`）：
   - 在 `model-registry.ts` 的 `MODELS` 加一条模型条目（`kind: 'asr' | 'translation'`）。每个文件的下载源是**按端分源的有序列表**，由 `model-sources.ts` 的构造器生成，下载器按序 fallback（每个源只试一次）：
     - `nativeUrls`（**macOS / iOS**）：`selfHostedAsset('<模型id>-<原文件名>')` 自托管直链**在首**，其后追加 `hfResolveUrls(<repo>, <rel>)` 上游做兜底（有上游者）。
     - `webUrls`（`platforms` 含 `web` 的模型）：`hfResolveUrls(<repo>, <rel>)`（上游主源 + 镜像，发 CORS 头）。GitHub Release 资产**不发 CORS 头**，浏览器 fetch 用不了，故 web 只能走 `webUrls`；macOS-only 模型（如 M2M100-1.2B）`webUrls` 留空。
   - 换镜像 / 换 owner / 换 release tag 只改 `model-sources.ts`（`SELF_HOSTED` / `HF` / `HF_MIRRORS`）一处；web 翻译缓存键主机 `TRANSFORMERS_REMOTE_HOST` 不可变、绝不跟镜像走（否则离线加载 miss）。
   - iOS 的 `AsrModels.swift` 是从注册表**生成**的提交物：改完注册表须重跑 `pnpm --filter @rt/ios gen:models` 并提交（CI 有 `--check` 兜底）。

3. **核验 URL**：对注册表里各文件下载源列表（`nativeUrls` / `webUrls`）内的每个 URL 做 HEAD 核验，确认最终都 200（GitHub Release 会 302 到 CDN，`-L` 跟随后应为 200）：

   ```bash
   curl -sIL <url> | grep -E '^HTTP'   # 期望最后一行 200
   ```

## 红线

- **正式版（非 beta）发布后，不得再重置/强推已发布的 tag**。
- 大文件（模型权重等）不进 git，也不走 GitHub LFS（免费带宽仅 1GB/月）；托管用 **GitHub Releases 资产**（单文件上限 2GB，公开仓免流量费）。
