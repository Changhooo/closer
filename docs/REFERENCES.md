# 调研与整合记录

检视日期：2026-10-13。检视来自 GitHub 原仓库的实际文件；提交号固定本次检视版本。设计借鉴不等于把上游功能全量移植。下表列出的做法在同屏 Lite 中为独立实现，没有直接搬入上游源文件。

| 项目 | 本次检视提交 | 许可证 |
| --- | --- | --- |
| [Piik](https://github.com/TNTcraftHIM/Piik) | `390e637d4e9090e6258ccc3d3a0a3f877d81b25c` | MIT，原 LICENSE 标注 TNTcraft and Piik contributors |
| [Weblink](https://github.com/99percentpeople/weblink) | `1319b75d18b492a6b139ee841e793c55c2404d0d` | MIT，原 LICENSE 标注 Zach Yuen |
| [MiroTalk P2P](https://github.com/miroslavpejic85/mirotalk) | `a53f345358049edc41bd2f06754b0304ef4af0c4` | AGPL-3.0 |

## Piik

实际查阅：

- `internal/server/protocol/types.go`：host/viewer 角色、路由上游类型、分辨率与音频质量枚举。
- `internal/server/route/quality.go`：质量证据与当前会话、连接、路由版本的匹配，拒绝旧状态影响当前连接。
- `internal/media/forwarding/output.go`：RTP 输出和源切换相关入口。

本项目落实：一时刻单一分享者、其余成员观看；只承认当前房间成员的信令；连接替换后丢弃旧会话回调；发送上限与实际画质分别展示。对应 `server.py` 的共享权和定向信令、`public/app.js` 的会话身份检查、`public/rtc.js` 的媒体统计。

没有移植：Piik App 的 Windows 原生采集、原生声音排除、媒体转发树、SFU 和复杂路由质量收敛。当前没有从 Piik 复用上述复杂质量控制代码。

## Weblink

实际查阅：

- `apps/web/src/libs/domain/peer-negotiation.ts`：处理队列、会话代际与 SDP 应用期间的状态校验。
- `apps/web/src/libs/application/meeting-media-service.ts`：屏幕捕获完成后的有效性检查，声音静音状态和采集结束时资源清理。
- `apps/web/src/libs/application/session-service.ts`：音视频发送参数与 `maxBitrate`。
- `docs/DESKTOP.md`：原生能力与浏览器能力区别，以及目标参数不代表链路吞吐保证。

本项目落实：独立麦克风/共享声音/屏幕槽位；共享声音静音不影响语音；在捕获弹窗期间离开后，立即停止迟到的采集结果；每个接收连接单独执行码率和帧率参数；分别展示直连/中继、上传/下载、实际画面。对应 `public/app.js`、`public/rtc.js` 和相应回归测试。

没有移植：Rust/Tauri 桌面壳、DXGI/WGC 捕获、H.264/HEVC 硬件编码、远程控制、共享文件等。本项目使用浏览器当前支持的编解码器，不强制或篡改 SDP 来声称硬件编码支持。

## MiroTalk P2P

实际查阅 `app/src/server.js` 的 `addPeerTo`、`removePeerFrom`：维护房间成员，并为成员对组织建立或清理连接的通知。

本项目落实：每对成员独立的连接；加入一个新成员不会重建其他成员间的连接；离开只清理相关连接；信令必须指定本房间内的目标成员，发送者身份由服务端填写。前端控制测试与服务端隔离测试覆盖相应行为。

MiroTalk 源文件为 AGPL-3.0，本项目没有复制它的服务端或前端代码。多人连接和定向信令是通用 WebRTC 架构，这里的协议与实现为独立编写。如果后续直接引入上游代码，需要按其许可证重新审查分发方式。

## 接口文档

- [屏幕捕获 getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)：HTTPS、用户手势、授权与音频可用性。
- [WebRTC perfect negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation)：双方协商、候选处理和冲突处理。
- [aiohttp WebSocket](https://docs.aiohttp.org/en/stable/web_reference.html#aiohttp.web.WebSocketResponse)：消息上限、心跳与连接生命周期。

当前整合重点是小群体可部署和媒体操作正确性。进一步减少多人高清共享时的发送者上行，需要新增 SFU 媒体转发架构，不能仅靠提高当前房间人数上限或增加 TURN 达到。
