# RayNeo iO 实验原型

本模块是 Subline iOS 的可选实验链路：发现并连接提供指定 BLE 服务的 RayNeo 设备，记录服务、特征和通知；在调用方显式开启实验写入并提供已验证的空口业务 ID 后，可尝试把 Subline 字幕封装成候选的 voice-assistant type 5 文本消息。当前没有自动握手、认证、绑定或页面唤醒流程，也没有镜片显示成功的回执，因此“已连接”“已提交 BLE 写入”和“眼镜已显示”是三个不同状态。

## Clean-room 来源与许可边界

实现仅依据交付给本项目的 `/tmp/rp/io-spec-for-impl.md` 中列出的协议事实重新编写，没有复制或包含 Turbo-IO 源码、二进制或其他实现材料。该规格本身是从既有材料整理出的派生事实说明；它不能单独证明参与人员之间的法律意义上的隔离，也不能替代来源、权利或专利审查。

规格记载相关项目当前原创材料采用 PolyForm Noncommercial License 1.0.0。事实重实现不等于自动获得商用许可，也不自动免除其他权利；若复制任何受许可软件部分，仍须遵守对应许可证和通知义务。Subline 在商业使用、分发或与厂商服务集成前需要独立法律审查。

## 模块与对外接口

- `ios/rayneo/RayNeoCodec.swift`：提供 CRC-16/XMODEM、TLV、传输帧、版本交换 TLV、iOS proof/session key 和 type 5 文本负载的纯编解码函数。文本以 UTF-8 字节计，最多 512 字节；JSON 转义后的消息长度可能更大。
- `ios/rayneo/RayNeoLink.swift`：CoreBluetooth central，仅扫描服务 `0000B81D-0000-1000-8000-00805F9B34FB`，连接调用方从扫描结果中选定的设备，发现服务/特征，订阅 notify/indicate，并记录 UUID、属性及通知十六进制。
- `ios/rayneo/RayNeoPlugin.swift` 与 `rayneo.ts`：Capacitor 插件 `RayNeo`，暴露 `scan`、`connect`、`disconnect`、`getStatus`、`getLog`、`sendText`，以及 `rayneoStatus`、`rayneoLog` 事件。
- `src/rayneo-forwarder.ts`：导出 `forwardRayNeoText` 和 `rayneoDebug`；原生 ASR 的定稿段立即尝试转发，部分结果最多每 250 ms 尝试一次。WebView 侧不维护写入队列；原生层会拒绝尚有 with-response 写入待完成时的新写入，也会在 without-response 当前不可写时拒绝，转发器只记录失败，不排队或重试。
- `window.__rayneo`：调试入口，提供 `scan`、`connect`、`status`、`log` 和 `sendTest(text)`。

## 写入安全边界

扫描只使用上述 B81D 服务过滤。写入只允许目标服务上的 outbound 特征 `EA8B70D5-2BD3-49AB-9C31-9C38B2C3C4F9`；代码不会写入 file 特征 `87654321-4321-4321-4321-ABCDEF123456`，也不会写入其他特征。所有 notify/indicate 特征都可订阅用于观察，但订阅不授权写入。

写入默认关闭。自动字幕转发要求以下三个 `localStorage` 值同时有效：

```js
localStorage.setItem('subline.rayneo.enabled', 'true')
localStorage.setItem('subline.rayneo.experimental', 'true')
localStorage.setItem('subline.rayneo.businessId', '<verified decimal 0..255>')
```

两个开关都必须逐字等于字符串 `true`。`businessId` 必须由调用方显式提供为十进制 `0...255`，没有默认值。厂商 SDK 内部枚举索引 `13` 不是已知的 transport wire business ID，不能把它当作默认业务 ID。缺少实验开关或合法业务 ID 时，字幕转发只写浏览器调试日志，原生 `sendText` 也会拒绝。

发送路径固定使用尚未验证的 `flags=0` 候选帧。实现不做 BLE MTU 切片；完整帧超过 CoreBluetooth 当前可写长度时直接拒绝。CoreBluetooth 写入完成也只表示系统层提交或响应，不表示协议 ACK、业务执行或镜片显示成功。日志会包含 UUID、广告信息、通知和实验出站数据的十六进制，仅保存在当前进程内存和系统日志中；实机测试前应把这些诊断数据按敏感数据处理。

## 未验证边界

- voice-assistant 的空口 `businessId` 未知；`flags=0`、页面状态以及完整外层路由均未实机确认。
- 完整握手顺序、应订阅的通知组合、认证请求外层路由、认证响应布局、成功确认及何时启用加密尚未闭合。本原型不会自动运行握手。
- 手机协议标识、设备地址和双方随机数的真实握手长度尚未硬件验证；编解码器中的 proof 与 session key 计算本身不建立绑定、不处理重放，也不证明认证成功。
- 连接、发现 outbound 特征或 BLE 写响应都不能证明已认证、已进入正确页面或已显示字幕。
- type 5 文本格式没有清屏、替换、坐标或局部更新字段；换行、覆盖、追加和刷新效果未知。

## 绑定与解绑风险

规格中的独立 V1 绑定路线要求先在官方 App 中解绑并确认完成，再在系统蓝牙中忽略设备，长按眼镜按钮约 5 秒确认蓝灯闪烁后重新配对；只关闭官方 App 不等于解绑，也不应让两个客户端同时抢连。这个原型不执行解绑、忽略设备、重置或绑定流程。

切换绑定可能破坏现有官方绑定且可能清除眼镜内容，不能承诺无损并存。本地记录清除或本地绑定数量归零不能证明设备端解绑完成。除非已接受内容丢失和恢复官方绑定的风险，不应为本原型主动解绑。

## 调试与验证

先在真机 Safari Web Inspector 控制台启动扫描。CoreBluetooth central 第一次创建时可能尚未报告 `poweredOn`，此时 `scan()` 会拒绝；等待状态更新后重试即可：

```js
await window.__rayneo.scan()
await window.__rayneo.status()
await window.__rayneo.connect('<id from status.devices>')
await window.__rayneo.status()
await window.__rayneo.log()
await window.__rayneo.sendTest('测试')
```

`sendTest` 同样要求 `subline.rayneo.experimental` 为 `true` 且已配置合法的 `subline.rayneo.businessId`。自动字幕转发还要求 `subline.rayneo.enabled` 为 `true`。每次实验后用 `status()` 和 `log()` 区分发现、连接、特征可写、系统写响应与实际镜片观察结果。

在仓库根目录运行静态检查和纯 Swift 编解码测试：

```sh
xcrun swiftc -parse -module-cache-path /tmp/rayneo-swift-cache \
  apps/ios/native-plugin/ios/rayneo/RayNeoCodec.swift \
  apps/ios/native-plugin/ios/rayneo/RayNeoLink.swift \
  apps/ios/native-plugin/ios/rayneo/RayNeoPlugin.swift

xcrun swiftc -module-cache-path /tmp/rayneo-swift-cache \
  apps/ios/native-plugin/ios/rayneo/RayNeoCodec.swift \
  apps/ios/native-plugin/tests/rayneo-codec-tests.swift \
  -o /tmp/rayneo-codec-tests
/tmp/rayneo-codec-tests

pnpm --filter @rt/core exec vitest run --root ../.. \
  apps/ios/src/rayneo-forwarder.test.ts
pnpm check
pnpm --filter @rt/ios build
```

纯 Swift 测试覆盖 CRC-16/XMODEM 标准向量、type 5 示例负载、帧往返与错误拒绝、TLV 往返、UTF-8 上限、JSON 转义、版本 TLV 结构及 proof 校验。forwarder 测试覆盖默认拒绝、显式路由、250 ms 部分结果节流、断连或非法业务 ID，以及异步读取状态期间关闭开关。它们验证本地编解码和转发门控行为，不验证 BLE、握手、业务 ID、认证或镜片显示。
