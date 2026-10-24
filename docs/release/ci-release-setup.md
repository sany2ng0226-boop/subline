# macOS CI 发布设置

推送 `v*` 标签会触发 `.github/workflows/release-macos.yml`，在 macOS runner 上执行与 CI 相同的测试、类型检查和 Swift 模型同步检查，发布 arm64 DMG。

## 配置证书与 API Key

在 macOS“钥匙串访问”的“我的证书”中找到 **Developer ID Application: JIANG ZIYANG (R9LRJU53ZG)**，展开确认存在私钥。选中证书及对应私钥，导出为 `cert.p12`，设置强密码。不要选择 Developer ID Installer 或 Apple Development 证书。

复制导出文件的 Base64：

```sh
base64 -i cert.p12 | pbcopy
```

在 App Store Connect 打开 **Users and Access > Integrations > Team Keys**，创建角色为 **Developer** 的团队 API Key。下载 `.p8`（只能下载一次），记下 **Key ID** 和 **Issuer ID**。没有创建权限时请由团队管理员操作。

```sh
base64 -i AuthKey_XXXX.p8 | pbcopy
```

进入 GitHub 仓库 **Settings > Secrets and variables > Actions > New repository secret**，分别添加：

| Secret | 内容 |
| --- | --- |
| `MACOS_CERT_P12_BASE64` | `cert.p12` 的 Base64 |
| `MACOS_CERT_P12_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `APPLE_API_KEY_P8_BASE64` | `.p8` 的 Base64 |
| `APPLE_API_KEY_ID` | API Key 的 Key ID |
| `APPLE_API_ISSUER_ID` | 团队的 Issuer ID |

`TEAM_ID=R9LRJU53ZG` 是普通配置。`GH_TOKEN` 使用工作流自带的 `github.token`，无需另建个人令牌。

## 发布版本

修改 `apps/macos/package.json` 的 `version` 为目标版本。打包脚本实际采用根 `package.json` 版本，所以根版本必须同时更新；可先修改根版本，再执行 `pnpm version:sync` 同步各包，检查 macOS 包版本已一致。工作流会同时校验标签、macOS 包版本和根版本，任一不一致即失败。

```sh
# 将根 package.json version 改为 X.Y.Z-beta.N 后
pnpm version:sync
# 审查并暂存本次版本修改
git diff
git add -u
git commit -m "chore: bump version to X.Y.Z-beta.N"
git push origin main
git tag vX.Y.Z-beta.N
git push origin vX.Y.Z-beta.N
```

上面的版本号是占位符，请替换为真实版本。暂存前确认没有混入无关改动。标签指向已推送的发布提交；包含 `-` 的标签发布为 prerelease，其他标签发布为正式版本。同标签运行不会取消正在进行的发布。不要移动已发布标签。

## 签名、公证与验证

CI 在 `RUNNER_TEMP` 创建随机密码的临时钥匙串并导入证书。现有打包脚本的 `--dir --manual-notarize` 使用既有 hardened runtime 和 `build/entitlements.mac.plist` 签名 arm64 App；新增参数显式传入 `-c.mac.notarize=false`，关闭 electron-builder 自动公证，且要求签名成功并关闭 builder 自动发布。

流程为：签名 App → `ditto` ZIP → `notarytool submit --wait` 等待 `Accepted` → staple App → electron-builder `--prepackaged` 将已装订的 App 包入 DMG → 签名 DMG → 公证并 staple DMG。这样 DMG 内的 App 自身已带票据。构建不会在装订后重新构建 App。

发布前执行 App 的严格 codesign 验证、App 与 DMG 的 Gatekeeper 检查、两者的 `stapler validate`，然后生成最终 DMG 的 SHA-256。GitHub Release 仅上传 `.dmg` 与 `.dmg.sha256`，不会上传 ZIP、私钥或构建目录。

## 查看与排错

在 GitHub **Actions > macOS release** 查看各步骤；完成后在 **Releases** 确认仅有 DMG 和校验文件。下载两个文件后在同一目录运行：

```sh
shasum -a 256 -c Subline-X.Y.Z-beta.N-arm64.dmg.sha256
```

- 版本检查失败：同步根包与 macOS 包版本并提交，再创建正确的新标签。
- 证书导入失败或找不到签名身份：检查 `.p12` 是否包含私钥、导出密码、证书有效期及团队 ID。
- API 认证失败：核对 `.p8`、Key ID、Issuer ID 是否属于同一 Team Key，Base64 是否完整。
- 公证失败：工作流打印提交结果；有 submission ID 时打印 `notarytool log`。按 Apple 的具体错误修复签名、entitlements 或凭据。网络故障未返回 ID 时可能无法取日志。
- Gatekeeper 或票据验证失败：工作流会阻止发布；检查对应签名、公证步骤，不绕过验证。
- Release 创建失败：检查仓库 Actions 写权限、远端标签和是否已有同名 Release。已有 Release 时本流程不会覆盖资产。

首次配置后仍需一次真实标签运行验证 Apple 服务与 GitHub 权限，并在目标 Mac 下载、挂载、启动及检查应用功能；静态 lint 不能代替实机验收。

## 安全

Secrets 仅通过步骤 `env` 注入，脚本不内联密钥、不启用 `set -x`。临时 `.p12` 导入后删除，临时钥匙串和 `.p8` 在 `always()` 清理步骤移除。runner 被强制终止时清理步骤可能无法执行，应依赖 GitHub 托管临时 runner 的销毁隔离。

配置完成后删除本机临时导出的 `.p12`、`.p8`，清空剪贴板；需要恢复副本时使用受控加密存储。Base64 不是加密。不要把这些文件、密码或 Base64 写进仓库、Issue、PR 或日志。如果泄露，立即撤销对应证书/API Key、重新签发或轮换，并更新 GitHub Secrets；只删除泄露文件或修改导出密码不足以撤销私钥。
