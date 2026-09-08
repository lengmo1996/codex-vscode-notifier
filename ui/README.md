# Codex 会话通知 / Codex Session Notifier

[GitHub](https://github.com/lengmo1996/codex-vscode-notifier) · [下载安装 / Downloads](https://github.com/lengmo1996/codex-vscode-notifier/releases/latest) · [反馈 / Issues](https://github.com/lengmo1996/codex-vscode-notifier/issues)

[中文](#中文) | [English](#english)

## 中文

**提示语言：** 通知菜单 → **语言 / Language**，可自由选择中文（默认）或 English；也可设置 `codexNotifier.language` 为 `zh-CN` 或 `en`，不依赖 VS Code 的界面语言。新弹窗、日志、历史列表和窗口标题立即使用所选语言，不重启采集、不改变已读状态。已有日志和输出频道名称在本次运行中保留；会话名称、路径、主机名和原始系统错误详情保持原样。SSH／容器需要同时更新配套采集器。升级后若旧通知后台仍在运行，请在任务空闲时关闭所有 VS Code 窗口，等待 10 秒后重新打开。

版本 0.4.1 · Windows x64 · 发布者 lengmo1996

只关注 **VS Code 的 Codex 插件**发起的本地文件夹、SSH 和容器会话。Codex 桌面 App、CLI 及来源无法确认的会话不提醒。这是社区扩展，并非 OpenAI 或 Microsoft 官方产品。

## 安装

在扩展市场只需搜索并安装 **Codex 会话通知**，发布者 **lengmo1996**，扩展 ID `lengmo1996.codex-notifier-ui`。主扩展通过扩展包关联配套采集器，无需再寻找第二个安装入口。

- **本地文件夹**：采集已内置，安装主扩展即可使用。
- **SSH／容器**：在目标窗口打开 **Codex 通知：检查／安装当前环境组件**。缺少采集器时会定位它的扩展页面，选择 **安装到 SSH／容器** 并启用即可。每个新服务器或容器需要检查一次。
- 缺少远端组件时，状态栏显示黄色 **Codex · 需安装远端组件**，点击即可进入上述引导。检查不主动发出通知声音、不重载窗口、不恢复已暂停的采集。

统一入口采用 VS Code 的 `extensionPack`，不保证把组件自动安装到所有未来连接的远端环境。扩展管理器可能在本机保留配套采集器；它在本地不启动采集，SSH／容器中的采集仍只在对应环境运行。配套组件可独立安装或卸载，不阻止主扩展在本地使用。

离线安装时，先在 Windows 安装 `codex-notifier-ui-0.4.1-win32-x64.vsix`；需要 SSH／容器采集时，在对应环境安装 `codex-notifier-collector-0.2.5.vsix`。离线 VSIX 不包含其他扩展的安装包，扩展市场尚未发布配套组件时请使用此方式。

本地需要 Python 3.8 或以上及受信任的本地文件夹。SSH／容器窗口不会启动 Windows 本地采集，空窗口不采集。

两端升级后，等待任务空闲再逐个执行 **Developer: Reload Window**。主扩展会静默忽略旧采集器缺少来源标识的事件，因此远端 0.1.0 必须升级。同一扩展 ID 升级保留历史；如果此前安装的是 `lengmo.*` 开发包，请先卸载它，避免与 `lengmo1996.*` 重复提醒；不同发布者 ID 的历史不自动迁移。旧版显式设置的本地采集配置会迁移到对应 Local 设置。

## 提醒与标读

- 对应窗口的未读回复用黄色标记，审批或提问用红色。窗口预览标题圆点持续闪动到已读。Windows 合并任务栏按钮只显示汇总颜色，扩展不改变整张缩略图背景。
- 默认本轮回复结束播放声音，并显示颜色和未读；审批／提问也按声音总开关提醒。回复结束默认不弹系统通知，可通过 **Sound On Done / Desktop On Done** 分别调整。标题显示“本轮已回复”，不把它称为整个任务完成。
- **新提醒默认未读；切回窗口不会自动标读。点击通知只标读被点击的那一条**，同一窗口、同一会话的其他提醒也保留原状态。
- **Auto Read On Window Focus 默认关闭**。如果主动开启，手动切回窗口会标读该窗口全部已有提醒；手动切换会话编辑器标签会标读该会话。通知主动跳转期间暂停自动标读。升级保留用户显式设置；此前手动开启过该项的用户需自行关闭。
- 单击通知默认回到目标窗口的 **Codex 插件会话侧栏**。通知菜单 → **选择会话打开位置** 可切换为中间主编辑器；对应设置为 **Open Location**。点击和标读全程静音。
- 窗口未连接、跳转报错或检测到侧栏跳转期间焦点改变时保留未读。VS Code 首次打开扩展链接可能要求确认；侧栏接口无法确认后端恢复结果，跳转请求返回只表示已请求打开，并不证明对话已加载。
- 已读仅表示处理过提醒，不表示批准操作、回答问题或后台训练／部署已经成功。

同一环境同一目录有多个窗口时，选择最近使用的匹配窗口。跳转已按 Codex 26.901.22334 的侧栏 URI 和编辑器接口核对。侧栏先聚焦目标窗口，再使用 VS Code 活动窗口路由，避免数字 windowId 前缀碰撞；它依赖分发时的活动窗口，快速切换窗口仍存在竞态，检测到焦点改变会保留未读。插件或 VS Code 更新后可能需要重新验证。侧栏当前会话没有公共读取接口，因此不根据侧栏切换自动标读。

## 删除通知

- 每条通知右侧或右键菜单：**删除这条通知**。
- “已读”分组、视图标题栏：**清空已读通知**，保留未读。
- 视图标题栏垃圾桶或通知菜单：**清空全部通知**。

仅删除通知历史，不删除 Codex 对话、代码或服务器文件。删除会取消尚未发出的对应提醒；已显示的 Windows 气泡按系统时限关闭。去重记录保留，重连不会立即恢复被删除条目。

## 设置与检查

搜索设置 `codexNotifier`。声音、弹窗、窗口标记、标题闪动和三类事件可以分别关闭；暂停仍记录历史。

本地使用 **Local Codex Home / Local Python Path / Local Source Label / Local Collector Enabled**；SSH／容器使用远端组件设置。Codex Home 留空使用该环境的 `CODEX_HOME` 或 `~/.codex`。

按 **Ctrl+Shift+P** 搜索：

- **Codex 通知：查看连接状态**。
- **Codex 通知：测试当前窗口采集链路**。
- **Codex 通知：测试本机弹窗和声音**（测试本身会主动发声）。
- **Codex 通知：配置当前环境的审批提醒**。

审批 hook 仍需在对应 Codex 设置的 Hooks → PermissionRequest 中核对并 Trust；扩展不代替审批。完成和提问采集默认不改 hook。

采集只传递事件、来源、目录和会话标识，不转发正文。源会话必须有 VS Code 插件专用来源标识；子代理完成不提醒。采集随 VS Code 工作区连接运行，具体扫描和离线回放上限见 Remote 说明。系统勿扰或静音可能影响弹窗和声音，历史仍可查看。

MIT License。

## 隐私与清理

默认通知缓存保留 7 天（可设置 1–30 天）。本机使用当前用户限定的管道及 TLS 双向认证；安装者之间没有公共会话同步。打开 **Codex 通知：隐私与数据清理** 可预览、清理并暂停；其他远端环境须分别清理。详细数据范围、账号共享边界和保留限制见 [隐私说明](PRIVACY.md)。

## 远端组件改名后的升级

配套组件的新 ID 为 `lengmo1996.codex-notifier-collector`。原远端市场条目删除后名称不可重用，因此主扩展 0.3.2 已改为关联新 ID。请保留主扩展市场条目并使用 Update；新远端组件使用 New extension 上传。

如果目标服务器或容器仍装有旧 `lengmo1996.codex-notifier-remote` 或 `lengmo.codex-notifier-remote`，请在任务空闲时卸载旧扩展，再安装新组件并重载该窗口，避免两个采集器同时注册相同命令。无需删除 Codex 原始会话或执行隐私清理；采集逻辑及既有数据目录未变。

## English

Version 0.4.1 · Windows x64 · Publisher: **lengmo1996**

Get sound, window indicators and unread reminders when **Codex in VS Code** finishes a response, asks a structured question or needs approval. Track local folders, Remote SSH servers and containers across multiple VS Code windows. Codex Desktop App sessions, standalone CLI sessions and sessions of unknown origin are excluded. This is a community extension, not an official OpenAI or Microsoft product.

### Install once, check each remote environment

Install **Codex 会话通知**, ID `lengmo1996.codex-notifier-ui`, from the Marketplace. The extension pack links its companion, `lengmo1996.codex-notifier-collector`.

| Environment | What runs there |
| --- | --- |
| Local VS Code folder on Windows | The main extension includes local collection. Python 3.8+ and a trusted folder are required. Empty windows do not collect. |
| Remote SSH server or container | The companion collects events in that environment. Windows local collection does not start for a remote window. |

In each SSH/container window, run **Codex Notifier: Check / install components for this environment** from the Command Palette, or click the yellow missing-component status indicator. On the companion's extension page, choose **Install in SSH / Container** and enable it. Check every new environment: extension packs do not guarantee installation into all future remote connections. A locally retained copy of the companion stays inactive and can be managed independently.

For offline installation, install `codex-notifier-ui-0.4.1-win32-x64.vsix` on Windows and `codex-notifier-collector-0.2.5.vsix` in the remote environment. A VSIX does not embed its extension-pack members. Reload affected windows after active tasks are idle.

### Understand the reminders

| Event or action | Default behavior |
| --- | --- |
| A response ends | Sound, yellow window indicator and unread history entry; no desktop popup by default. This means the current response ended, not that the overall goal or a background job finished. |
| Approval or structured question | Sound and a red window indicator. Approval requires a configured and trusted hook. |
| Return to a VS Code window | Existing notifications remain unread. |
| Click a notification | Silently request its session in the target window's Codex sidebar and mark only that notification read. Other reminders retain their state. |
| Delete a notification | Remove it from history; do not delete the original Codex conversation. |

Unread status dots in window preview titles alternate every 0.8 seconds. Marking read stops the indicator. Windows may aggregate taskbar indicators; the extension does not flash the entire thumbnail background. Do Not Disturb, muted audio and system notification policies can affect delivery.

**Auto Read On Window Focus is off by default.** If explicitly enabled, manually returning to a window marks all its existing reminders read; switching conversation editor tabs marks that session's reminders read. Notification-initiated navigation temporarily suspends automatic acknowledgement. Updates preserve explicit preferences, so turn this setting off if you enabled it before. New events arriving while a window stays focused are not consumed automatically.

Read state acknowledges a reminder; it does not approve a tool action, answer a question or confirm that a deployment succeeded.

### Choose where a session opens

Notification menu → **Choose session opening location**, or set **Open Location**:

- `sidebar` (default): return to the Codex extension's session sidebar.
- `editor`: open the session as a tab in the central editor area.

Disconnected windows, navigation errors and detected focus changes during sidebar routing preserve unread state. Sidebar links focus the destination first, then use VS Code's active-window routing to avoid numeric window-ID prefix collisions. Rapid window switching still introduces a race. VS Code may request confirmation when opening an extension link for the first time. Neither a returned sidebar request nor an open editor tab proves that Codex's backend has successfully resumed the conversation. No public API exposes the sidebar's current session, so sidebar selection itself is not used for automatic read tracking. Routing was inspected against Codex extension 26.901.22334; updates may require compatibility work.

When multiple windows share the same environment and directory, the most recently used matching window is selected.

### Manage history and settings

Use **Delete this notification**, **Clear read notifications**, or **Clear all notifications** from the notification view. Deletion cancels queued reminders and retains bounded deduplication records so reconnecting does not immediately restore them. Already displayed system notifications expire according to Windows policy.

Search VS Code settings for `codexNotifier`. **Sound**, **Sound On Done**, **Desktop Notifications**, **Desktop On Done**, **Taskbar Attention**, **Blink Window Title** and the three event-type switches are independent controls. **Pause alerts** keeps recording history; privacy cleanup pauses reception as well.

Local folders use **Local Codex Home / Local Python Path / Local Source Label / Local Collector Enabled**. Remote environments use the companion's settings. An empty Codex Home uses that environment's `CODEX_HOME`, then `~/.codex`.

Useful Command Palette actions include **Show connection status**, **Test collection in this window**, **Test desktop notification and sound**, and **Configure approval reminders for this environment**. A notification test intentionally plays sound when enabled. To receive approval reminders, review and trust the managed **PermissionRequest** hook in that environment's Codex settings. The extension never makes approval decisions. Response and question collection does not automatically install a hook.

### Privacy, retention and upgrades

The extension forwards allowlisted event metadata, including environment labels, paths and session identifiers, not prompt or response bodies. The collector locally parses session logs to identify these events. History is intentionally shared among the same OS user's local VS Code windows. There is no developer-operated synchronization server or telemetry upload; installing this extension does not connect another user to the author's sessions. Shared remote OS accounts or shared Codex Home directories are not separate privacy boundaries.

Notification caches default to **7 days**, configurable from **1–30 days**. **Privacy and data cleanup** previews the scope, clears managed data and pauses collection/reception. Explicit resume is required. Original Codex conversations, credentials, project files and unrelated hooks are preserved. Other remote environments must be cleaned separately. See the bilingual [privacy policy](PRIVACY.md) for data fields, authentication, storage, backups and cleanup limits.

If an environment still has `lengmo1996.codex-notifier-remote` or `lengmo.codex-notifier-remote`, uninstall that old companion before installing `lengmo1996.codex-notifier-collector`, then reload when tasks are idle. Do not run both collectors together. Main-extension updates under the same ID retain history; history is not automatically migrated between publishers. Publishers should update existing Marketplace entries instead of deleting them.

Open the notification menu → **语言 / Language** to choose **中文** or **English**, or set `codexNotifier.language` to `zh-CN` (default) or `en`. This setting is independent of the VS Code display language. New popups, logs, history labels, and window title markers use the selected language immediately; the collector keeps running and unread states are preserved. Existing log lines and the current output channel name remain unchanged until reload. Session names, paths, hostnames, and raw OS error details are preserved. Each native popup uses its target window’s language. If an older background component is still running after upgrading, close all VS Code windows when tasks are idle, wait 10 seconds, and reopen.

MIT License.
