# CodexBar for Windows

CodexBar 的 Windows 移植版本，以系统托盘应用运行，集中展示 Codex 与 Claude Code 的账户、额度、Token 用量和 Hook 统计。

原 macOS 版本是 Swift 6 加 SwiftUI 的菜单栏应用，依赖 AppKit、`IOPMAssertion`、`SMAppService` 与 root helper；这些系统能力在 Windows 上没有对应实现，因此本目录用 Electron 与 TypeScript 重新实现了与平台无关的三条数据链路，并保留主面板的展示能力。

## 已移植的功能

- 展示当前 Codex 账户、套餐与 `app-server` 实际运行版本
- 展示全部额度窗口、剩余比例与重置时间，包含 Credits 与可用重置次数
- 展示累计 Token、单日峰值、连续使用天数与最长连续天数
- 展示最长任务时长，优先取官方口径，缺失时回退本机会话统计
- 通过 30 周热力图回顾每日 Token 用量，可点击方格查看当日明细
- 开启 CodexBar Hook 后按天统计会话、对话轮次、工具调用、子 Agent、审批请求与上下文压缩
- 估算当前 5 小时窗口与周限窗口的可用总额度，给出预计剩余 Token 与样本置信度
- 展示本机 Claude Code 账户、套餐、额度窗口、Token 用量与热力图

## 暂未移植的功能

以下能力依赖 macOS 专有机制或本仓库的多机器链路，本次移植没有包含：

- 防止系统睡眠、低电量保护、异常会话保护与 root helper
- 额度自动重置与系统唤醒计划
- 实时任务卡片、任务中心、任务流光与通知
- SSH 多机器用量中心、官网账号分析与订阅价值估算
- Sparkle 自动更新

## 运行要求

- Windows 10 1809 或更高版本，x64
- Node.js 20 或更高版本，用于构建；Hook 子进程也优先复用它
- 已安装并登录 [Codex CLI](https://github.com/openai/codex)，当前运行版本不低于 `0.145.0`
- 使用 Hook 统计时，当前运行版本不低于 `0.150.0`
- Claude 统计需要本机存在可读取的 Claude Code 会话日志

## 构建与运行

```powershell
cd Windows
npm install
npm start
```

`npm start` 会先编译 TypeScript 再启动 Electron。应用启动后不占用任务栏，图标出现在系统托盘：左键打开主面板，右键打开菜单。

打包安装程序：

```powershell
npm run package
```

产物位于 `Windows\release`，包含 NSIS 安装包与免安装 zip。打包配置把 `hook\record.js` 放进 `resources\hook`，保证 Hook 子进程无需解包 asar 即可执行。

## 验证

```powershell
npm test
```

测试使用 Node 内置的 `node:test`，覆盖路径解析、额度模型、Hook 事件编码、历史聚合、热力图、额度估算、`hooks.json` 改写、`app-server` JSON-RPC、Claude 日志解析、服务装配、主进程装配与渲染层。测试全部在独立临时目录中运行，不会读写真实的 `~/.codex`、`~/.claude` 与应用数据目录。

`app-server` 与 Hook 子进程使用替身脚本验证，不需要真实的 Codex 登录状态；主进程用桩替换 `electron`，渲染层在 jsdom 中挂载真实页面并断言渲染结果。

第一次在自己的机器上排查环境时，可以运行不启动界面的自检：

```powershell
npm run doctor
```

它会打印 Codex 与 Claude 配置目录、解析到的 `codex` 路径与实际运行版本、账户与套餐、主次窗口已用比例、Hook 配置状态与命令，以及本机会话扫描进度。

## CodexBar Hook

在设置面板打开 `启用 Hook 统计` 后，应用会：

1. 读取 `%USERPROFILE%\.codex\hooks.json`，只为每个事件追加一个独立 group，保留用户与其他应用已有的 handler
2. 按事件写入 handler 超时，`SessionEnd` 与 `Interrupt` 为 3 秒，其他事件为 5 秒
3. 通过 `app-server` 的 `config/read` 确认 Hook 没有被全局禁用，再用 `hooks/list` 校验 Codex 是否真的加载
4. 需要时用 `config/batchWrite` 写入 `hooks.state` 的 `trusted_hash`，完成信任

Hook 命令优先写成 `node "<安装目录>\resources\hook\record.js" --hook-event`，没有 `node` 时回退到应用自身的 `--hook-event` 模式。子进程读取 `stdin` 的 JSON 负载，在锁内追加一行 JSONL 后立即退出，任何失败都静默吞掉，不会阻断 Codex。

开关保持开启时，每轮刷新都会比对配置：缺少事件或命令路径发生变化会自动补齐，这样升级安装目录或更换 `node` 位置后不需要手工重开开关。

关闭开关时只移除 command 同时包含当前可执行路径与 `--hook-event` 的 handler。

## 数据与隐私

本机数据目录默认是 `%APPDATA%\CodexBar-yatotm`，可用 `CODEXBAR_DATA_DIR` 覆盖：

| 路径 | 内容 |
| --- | --- |
| `HookEvents\events\YYYY-MM-DD.jsonl` | Hook 子进程写入的原始事件 |
| `HookEvents\daily.jsonl` | 按天聚合结果 |
| `HookEvents\maintenance.json` | 增量偏移、文件身份与聚合算法版本 |
| `rollout-state.json` | 本机 Codex 会话的增量扫描状态与按日 Token |
| `claude-state.json` | 本机 Claude Code 会话的增量扫描状态 |
| `quota-observations.json` | 额度窗口观测点，用于估算窗口总额度 |
| `settings.json` | 应用设置 |
| `codexbar.log` | 运行日志 |

原始事件与按日聚合保留 210 天，会话与轮次标识只保留 3 天，到期后只留去重计数。所有数据都留在本机，应用不向 Anthropic 或任何第三方上报；与 Codex 官方服务的通信全部经由本机 `codex app-server` 完成。

日志只记录结果分类与聚合数字，不写入任务内容、项目名、会话标识与登录凭据。

## 目录结构

```
Windows/
├── src/core/        与 Electron 无关的纯逻辑, 可单独测试
│   ├── appServer.ts     app-server stdio JSON-RPC
│   ├── codexResolver.ts codex 可执行文件解析与版本判定
│   ├── quota.ts         额度与用量模型
│   ├── hookEvent.ts     Hook 事件编码与落盘
│   ├── workflow.ts      每日聚合与增量维护
│   ├── rollouts.ts      本机 Codex 会话扫描
│   ├── claude.ts        本机 Claude Code 扫描与额度缓存
│   ├── estimate.ts      窗口总额度估算
│   └── heatmap.ts       30 周热力图网格
├── src/main/        Electron 主进程, 托盘, 面板与服务装配
├── src/renderer/    主面板界面
├── src/test/        node:test 测试
└── hook/record.js   零依赖 Hook 子进程脚本
```

## 与 macOS 版本的行为差异

- 托盘图标不承载任务状态，工具提示显示账户与各窗口剩余比例
- 额度估算是本移植新增的能力，依赖本机会话日志中的 Token 与额度百分比观测，样本不足时只展示参考值
- Hook 子进程用锁文件代替 `flock`，等锁预算仍然比事件超时少 2 秒
- `%APPDATA%` 下没有 Debug 与 Release 两套数据目录，调试构建与打包构建共用同一份数据
