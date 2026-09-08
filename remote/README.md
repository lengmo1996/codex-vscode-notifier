# Codex 远端通知采集器（lengmo1996）

[GitHub](https://github.com/lengmo1996/codex-vscode-notifier) · [下载安装 / Downloads](https://github.com/lengmo1996/codex-vscode-notifier/releases/latest) · [反馈 / Issues](https://github.com/lengmo1996/codex-vscode-notifier/issues)

[中文](#中文) | [English](#english)

## 中文

**提示语言：** 通知菜单 → **语言 / Language**，可自由选择中文（默认）或 English；也可设置 `codexNotifier.language` 为 `zh-CN` 或 `en`，不依赖 VS Code 的界面语言。新弹窗、日志、历史列表和窗口标题立即使用所选语言，不重启采集、不改变已读状态。已有日志和输出频道名称在本次运行中保留；会话名称、路径、主机名和原始系统错误详情保持原样。SSH／容器需要同时更新配套采集器。升级后若旧通知后台仍在运行，请在任务空闲时关闭所有 VS Code 窗口，等待 10 秒后重新打开。

版本 0.2.5。配套组件 ID：`lengmo1996.codex-notifier-collector`。

仅在 SSH 服务器或容器工作区中采集 VS Code Codex 插件会话，将回复结束、审批和提问交给 Windows 本机组件。Codex App、CLI 和无法确认来源的会话不提醒。

在目标 **Remote SSH 窗口**或**附加容器窗口**中，通过扩展面板 **… → 从 VSIX 安装**选择 `codex-notifier-collector-0.2.5.vsix`，确认安装在服务器或容器中。Windows 本机安装 `codex-notifier-ui-0.4.1-win32-x64.vsix`，它内置本地采集，本机不需要 Remote；Remote 在本地窗口不会启动。此扩展并非 OpenAI 或 Microsoft 官方产品。

两端升级后，等待任务空闲再重载对应窗口。新版 UI 会忽略旧采集器缺少来源标识的事件，因此远端 0.1.0 也必须升级。现有审批 hook 不必重新授权；采集出口会再次验证来源，旧 hook 写入的 App 事件也被忽略。

## 首次使用

远端需要 **Python 3.8 或更高版本**和受信任的 VS Code 工作区。采集默认启用，但**不会自动安装审批 hook**。

1. 运行 **Codex Notifier: 查看采集器状态**，核对 `codexHome`、Python、`connected` 和 `uiConnected`。
2. 运行 **Codex Notifier: 测试远端通知链路**，确认本机历史出现此环境的测试事件。
3. 要获得审批提醒，运行 **Codex Notifier: 配置审批提醒 Hook**。再到该环境的 **Codex 设置 → Hooks → PermissionRequest**，核对 `vscode-notifier/remote_notifier.py` 并点击 **Trust**。

重复配置不会重复添加 hook，并会保留已有无关配置和备份。扩展不会修改审批决定；`hookConfigured` 为真也不代表 hook 已被 Codex 信任。

## 设置

在该环境的 VS Code 设置中搜索 `codexNotifier`：

| 设置 | 用途 |
| --- | --- |
| **Codex Home** | 该环境实际运行 Codex 的用户配置目录；留空先用 `CODEX_HOME`，否则 `~/.codex` |
| **Python Path** | Python 可执行文件路径，不含命令参数；Linux 默认 `python3` |
| **Source Label** | 在本机通知中显示的服务器或容器名称 |
| **Collector Enabled** | 启用或停用此环境采集，默认启用 |

修改后可运行 **Codex Notifier: 重启采集器**。容器内运行 Codex 时，扩展、Python 和 Codex home 必须对应容器内同一用户的环境。

## 范围

完成和结构化提问使用已核对的 Codex **0.153.0** 日志格式识别；这是版本相关的适配，不是公开稳定 API。审批提醒使用 `PermissionRequest` hook，需当前 Codex 支持并由用户 Trust。

已发现会话每约 **2 秒**读取增量，新会话每约 **10 秒**发现一次。最多观察近 **36 小时**更新的 **64 个**会话日志，包括恢复后更新的旧会话。只向本机传递通知元数据，不转发提示词、回答正文或执行命令参数。

会话首行必须具有 `originator=codex_vscode`；`source=vscode` 本身不能区分桌面 App。主会话回复结束才产生完成提示，子代理结束静默；插件子代理的提问／审批仍可提醒。

扩展跟随当前 VS Code 连接运行，不另建 SSH 通道、不重配 SSH 密钥。窗口关闭或连接断开时不保证即时提醒；重连尝试回放最近 **5 分钟**事件，不补齐全部离线历史。

“完成”表示本轮生成结束。纯文字问题出现在最终回复时由完成事件覆盖。远端测试成功不证明 Windows 弹窗实际可见，也不证明真实审批 Trust 已完成；首次使用时请在各目标环境观察实际事件。

## 移除

运行 **Codex Notifier: 移除审批提醒 Hook** 可只移除本扩展管理的 hook，随后禁用或卸载扩展。它使用独立的 `vscode-notifier` 目录和管理标识，不会自动移除旧独立脚本工具的 hook。已经部署旧工具时，请停止旧接收器并用旧工具自己的卸载入口移除其 hook，避免重复通知。

MIT License。

## 隐私与清理

默认通知缓存保留 7 天（可设置 1–30 天）。本机使用当前用户限定的管道及 TLS 双向认证；安装者之间没有公共会话同步。打开 **Codex 通知：隐私与数据清理** 可预览、清理并暂停；其他远端环境须分别清理。详细数据范围、账号共享边界和保留限制见 [隐私说明](PRIVACY.md)。

## 远端组件改名后的升级

配套组件的新 ID 为 `lengmo1996.codex-notifier-collector`。原远端市场条目删除后名称不可重用，因此主扩展 0.3.2 已改为关联新 ID。请保留主扩展市场条目并使用 Update；新远端组件使用 New extension 上传。

如果目标服务器或容器仍装有旧 `lengmo1996.codex-notifier-remote` 或 `lengmo.codex-notifier-remote`，请在任务空闲时卸载旧扩展，再安装新组件并重载该窗口，避免两个采集器同时注册相同命令。无需删除 Codex 原始会话或执行隐私清理；采集逻辑及既有数据目录未变。

## English

Version 0.2.5 · Companion ID: `lengmo1996.codex-notifier-collector`

Collect notification events from **Codex running in VS Code over Remote SSH or inside a container**. Send response-end, approval and structured-question metadata to the Windows notification extension. Codex Desktop App sessions, standalone CLI sessions and unclassified sessions are excluded. This community extension is not an official OpenAI or Microsoft product.

### Installation and first use

Start with the main extension, **Codex 会话通知** (`lengmo1996.codex-notifier-ui`), on Windows. In the target SSH/container window, run **Check / install components for this environment** and install/enable this companion in that remote environment. For offline use, install `codex-notifier-collector-0.2.5.vsix` there and `codex-notifier-ui-0.4.1-win32-x64.vsix` on Windows.

The remote environment requires **Python 3.8+** and a trusted workspace. The extension, Python and Codex Home must belong to the user/environment actually running Codex. The companion does not start collection in local windows: local-folder collection is already included in the main extension.

1. Run **Show collector status** and check Codex Home, Python, `connected` and `uiConnected`.
2. Run **Test remote notification delivery** and verify that the test appears in the Windows notification history.
3. For approval reminders, run **Configure approval reminder hook**. In that environment's Codex settings, review **Hooks → PermissionRequest**, check the managed `vscode-notifier/remote_notifier.py` script, and choose **Trust**.

Collection is enabled by default, but hook installation is not automatic. Repeated hook configuration avoids duplicates and preserves unrelated configuration and backups. The extension never approves an action; `hookConfigured` does not prove Codex trusts the hook. Reload affected windows only after tasks are idle.

### Settings

Search for `codexNotifier` in the remote environment's settings.

| Setting | Meaning |
| --- | --- |
| **Codex Home** | Actual Codex configuration directory for this environment; empty uses `CODEX_HOME`, then `~/.codex`. |
| **Python Path** | Executable path without arguments; Linux defaults to `python3`. |
| **Source Label** | Server/container label displayed in Windows notifications. |
| **Collector Enabled** | Enable or disable collection in this environment; enabled by default. |
| **Cache Retention Days** | Keep collector notification caches for 1–30 days; default 7. Expiry runs during collection. |

Use **Restart collector** after configuration changes when needed. Sound, colors, read state, history deletion and the sidebar/editor opening preference belong to the main extension. Response-end sound is on by default there; window-wide automatic read acknowledgement is off by default in current main-extension versions.

### Collection scope and limitations

The collector recognizes response-end and structured-question records using the inspected **Codex 0.153.0** log format. This is a version-dependent integration, not a stable public API. Approval reminders require `PermissionRequest` hook support and explicit user trust.

Known sessions are read incrementally about every **2 seconds**; new sessions are discovered about every **10 seconds**. Up to **64** session logs modified within **36 hours** are observed, including older sessions updated on resume. Only allowlisted event metadata is forwarded, not prompts, response bodies or executed-command arguments. Logs containing conversation text are parsed locally.

The first session metadata record must identify `originator=codex_vscode`; `source=vscode` alone does not distinguish the Desktop App. Main-session response completion produces an alert; subagent completion is silent, while eligible subagent approval/question events may still alert. “Completed” means a response ended, not that the whole task succeeded. A plain-text question in a final response is covered by the response-end event.

The collector runs with the VS Code connection. It does not create another SSH connection or copy/reconfigure SSH keys. Immediate delivery is not guaranteed after a window closes or the connection drops. Reconnection attempts to replay the latest **5 minutes** of events, not the entire offline history. A successful test does not prove a Windows popup was visible or that a real approval hook was trusted.

### Privacy, cleanup and removal

Metadata can include hostnames, labels, directories, Codex Home, timestamps, session IDs and turn IDs. There is no developer-operated synchronization service or telemetry upload. Users who share a remote OS account, container user or readable Codex Home can see the same events; source labels and SSH keys do not provide separate access controls. Use separate OS accounts and restricted directories when isolation is required.

Notification caches default to **7 days** (configurable **1–30**). From the main extension, **Privacy and data cleanup** previews and clears managed data for the current environment and Windows, then pauses collection/reception until explicitly resumed. Original Codex conversations, login information, projects and unrelated hooks are preserved. Each remote environment must be cleaned separately. Unattributed old hook backups are retained and reported. The bilingual [privacy policy](PRIVACY.md) describes authentication, data fields, storage and deletion limits.

To remove only the managed approval hook, run **Remove approval reminder hook**, then disable or uninstall the companion. The managed `vscode-notifier` directory and ownership markers do not automatically remove hooks from older standalone tools; use those tools' own removal procedure to avoid duplicate notifications.

If upgrading from `lengmo1996.codex-notifier-remote` or `lengmo.codex-notifier-remote`, uninstall that old extension in each affected environment before enabling this companion. Commands and data directories remain compatible, but both extensions must not register the same commands simultaneously. Do not delete original conversations during this migration.

Runtime popups and collector logs follow the main extension’s **语言 / Language** selection (`codexNotifier.language`): Chinese by default, or English. Changing language does not restart collection. Previously written logs and raw OS error details remain unchanged. Update both components to use this feature in SSH/container windows.

MIT License.
