# 隐私与数据说明 / Privacy and Data Policy

[中文](#中文) | [English](#english)

## 中文

适用版本：主扩展 0.3.0–0.4.1、远端采集器 0.2.0–0.2.5。社区扩展，非 OpenAI 或 Microsoft 官方产品。

## 数据去向与隔离

本扩展没有开发者运营的同步服务器、遥测上传或账号绑定。别人安装同一个扩展，会使用对方运行环境中的数据目录，不会因此连接开发者的机器或取得开发者的会话。扩展代码与 VSIX 安装包不包含作者的运行数据或登录信息。

本地文件夹的采集在本机执行；SSH／容器的采集在对应远端环境执行，通知元数据经已有 VS Code 连接传到本机。扩展不另建 SSH 通道、不复制 SSH 私钥。远端窗口不启动本机采集。

同一用户的多个 VS Code 窗口有意共享通知历史。来源标签、窗口匹配和会话来源字段用于筛选及跳转，不构成不同人的访问权限隔离。如果多人共用同一个服务器账号、容器用户或可读取的 Codex Home，可能采集到同一批通知。不同 SSH 密钥登录同一账号也不会获得独立隔离。需要隔离时，应使用独立系统账号、独立且权限受限的数据目录。

本机组件使用 TLS 双向认证和固定证书校验。通信身份在当前用户的受保护目录中生成，长期私钥不通过管道发送；Windows 管道只允许当前用户访问并拒绝网络客户端。旧版通信令牌不会作为新版身份使用。系统管理员和已经具有同一用户文件权限的程序仍属于该用户的系统信任范围；本扩展不为其他 VS Code 扩展提供独立沙箱。

## 读取、传递与保存的数据

采集器从该环境设置的 Codex Home（否则 CODEX_HOME 或该系统用户的 ~/.codex）读取会话日志，以识别回复结束、结构化提问和审批请求。它会在本地解析包含会话正文的日志片段；仅转发经过字段筛选的事件元数据，不转发提示词、回答正文或执行命令参数。

通知元数据包括事件类型、事件时间、主机名、来源标签、工作目录、Codex Home、会话和轮次标识。主机名、目录和活动时间本身也可能敏感。窗口标题、通知面板、系统弹窗和用户主动打开的状态日志可能显示这些信息；屏幕共享和系统通知策略也会影响可见性。

只采集能确认由 VS Code Codex 插件发起的会话。Codex App、CLI 和无法确认来源的会话被忽略；在同一个 Codex Home 中，采集范围不是仅限当前打开的项目。

## 保留期与存储

| 位置 | 数据 | 生命周期 |
| --- | --- | --- |
| VS Code 当前用户的扩展 globalStorage | 当前通知历史、去重记录、旧版本缓存 | 默认 7 天；可设置 1–30 天；最多 200 条历史、5000 条去重记录；运行时及重新启动时清理过期记录 |
| Codex Home 下 vscode-notifier 目录 | 审批通知队列及轮转文件、扩展配置和复制的 Hook 脚本 | 通知缓存默认 7 天，可设置 1–30 天；采集器运行时执行保留策略 |
| Codex Home 下 hooks.json | 扩展管理的审批提醒 Hook 与原有无关 Hook | 只在用户选择配置或移除时改动 |
| Hook 配置备份 | 修改前的完整 Hook 配置，可能包含无关私密参数 | 新版记录自己创建的备份归属；无法确认归属的历史备份不会自动删除 |
| 本机通信身份及隐私暂停控制 | 本机专用证书/私钥、保留期、暂停状态、清理时间 | 维持通信和阻止旧事件重放所需；不含会话正文或会话标识 |

通知历史是受系统文件权限保护的明文元数据，不是加密资料库。Windows 专用存储权限限制到当前用户；POSIX 新通知目录和文件使用仅所有者权限，并拒绝不安全的清理路径。实际账号共享、原有文件权限和备份权限仍应由环境所有者管理。

扩展未通过 VS Code 的 setKeysForSync 注册通知历史。VS Code 自身可在同一账号下同步扩展列表和部分设置，这与向其他安装者同步会话不同。企业漫游配置、磁盘备份或用户自行复制数据目录可能另外复制这些文件。

## 删除、彻底清理与恢复

删除单条、清空已读或清空全部通知，只删除当前面板历史，并保留有限时间的去重信息，避免重连立即补回。

需要清理更多数据时，打开 **Codex 通知：隐私与数据清理**：

- **清理当前环境及本机通知数据**：先展示范围，确认后清理所有本机窗口共享的通知历史、旧版缓存和去重记录，以及当前环境能够确认归属的采集缓存、复制脚本和审批提醒 Hook。清理后暂停当前环境采集和本机接收。
- **仅清理本机全部通知缓存**：可在远端未连接时使用；不会删除服务器或容器中的文件。
- **恢复当前环境采集和本机接收**：用户显式恢复后只接收清理后的事件。已删除的审批提醒 Hook 需要重新配置，并在 Codex 中再次核对及信任。

其他 SSH 服务器／容器需分别连接后清理。无法确认归属的旧 Hook 备份会在预览或状态中说明并保留；系统日志、终端历史、Windows 已显示通知、磁盘快照与外部备份不属于本扩展可保证清除的范围。旧版本窗口应升级并重载，否则仍可能写入旧缓存。

清理不会删除原始 Codex 对话、登录信息、项目文件或无关 Hook；会保留不含会话标识的最小暂停控制及本机通信身份，防止旧事件在其他窗口重放。这是应用数据删除，不是磁盘安全擦除或对备份的删除保证。清理前会确认文件范围；不安全路径、链接或归属变化会导致拒绝或明确报告未完成，不能将部分清理当成全部成功。

## 发布包

发布只使用经过文件白名单、敏感内容检查和 SHA-256 复核的 VSIX。运行缓存、测试生成目录、账号文件、开发机器路径和排障导出文件不属于公开包。公开的发布者标识、扩展名称、版本和源代码可以被安装者查看。

## English

Applies to main-extension versions 0.3.0–0.4.1 and remote-collector versions 0.2.0–0.2.5. This is a community extension, not an official OpenAI or Microsoft product.

### Data destinations and isolation

There is no developer-operated synchronization server, telemetry upload or account binding. Other people installing this extension use their own environment's data directories; installation does not connect them to the author's computer or expose the author's sessions. Published extension packages do not include the author's runtime data or credentials.

Local-folder collection runs on the local computer. SSH/container collection runs in that remote environment, and notification metadata reaches Windows through the existing VS Code connection. The extension does not create another SSH channel or copy SSH private keys. Remote windows do not start Windows local collection.

Local VS Code windows belonging to the same OS user intentionally share notification history. Source labels, window matching and session-origin fields provide filtering and navigation, not access isolation between people. Sharing a server account, container user or readable Codex Home can expose the same notifications. Different SSH keys for the same account do not create separate isolation. Use separate OS accounts and separately permissioned directories when required.

Local components use mutual TLS authentication and pinned certificates. Communication identities are generated in the current user's protected storage; long-term private keys are not transmitted over the pipe. Windows pipes allow only the current user and reject network clients. Legacy communication tokens are not reused as new identities. Administrators and programs already running with the same user's file permissions remain within the OS trust boundary. This extension does not sandbox other VS Code extensions.

### Data read, transmitted and stored

The collector reads session logs from the configured Codex Home, otherwise `CODEX_HOME` or the OS user's `~/.codex`, to identify response completion, structured questions and approval requests. It locally parses log portions that can contain conversation text. Only allowlisted event metadata is forwarded; prompts, response bodies and executed-command arguments are not forwarded.

Metadata includes event type and time, hostname, source label, working directory, Codex Home, session ID and turn ID. Paths, hostnames and activity times can themselves be sensitive. Window titles, history panels, system popups and status logs opened by the user may display them. Screen sharing and system notification policies affect who can see this information.

Only sessions confirmed to originate in the VS Code Codex extension are collected. Desktop App, CLI and unknown-origin sessions are ignored. Within the same Codex Home, collection is not limited to the project currently open in VS Code.

### Retention and storage

| Location | Data and lifetime |
| --- | --- |
| The current OS user's VS Code extension globalStorage | Notification history, deduplication records and legacy caches. Default retention: 7 days; configurable 1–30 days. Up to 200 history entries and 5,000 deduplication records. Expiry runs while active and on restart. |
| `vscode-notifier` under Codex Home | Approval-event queue and rotated files, extension configuration and copied hook scripts. Notification caches default to 7 days, configurable 1–30; retention runs during collection. |
| `hooks.json` under Codex Home | Managed approval hook and existing unrelated hooks. Modified only when the user chooses configuration, removal or relevant cleanup. |
| Hook-configuration backups | Full pre-change hook configuration, potentially including unrelated private parameters. New versions track ownership of their backups; old backups with unknown ownership are not automatically deleted. |
| Local communication identity and privacy controls | Certificates/private keys, retention setting, pause state and cleanup cutoff. Retained to support communication and prevent replay; no conversation bodies or session identifiers. |

Notification history is plaintext metadata protected by OS file permissions, not an encrypted vault. Windows storage is restricted to the current user. New POSIX notification directories and files use owner-only permissions, and unsafe cleanup paths are rejected. Environment owners remain responsible for account sharing, existing file permissions and backup permissions.

Notification history is not registered with VS Code `setKeysForSync`. VS Code may synchronize extension lists and some settings under the same VS Code account; that is separate from sharing sessions with other installers. Roaming profiles, disk backups and user-created directory copies can independently copy these files.

### Deletion, full cleanup and resume

Deleting an item, clearing read items or clearing all notifications removes current history and retains bounded deduplication information to avoid immediate replay on reconnect.

For broader cleanup, open **Privacy and data cleanup**:

- **Clear notification data in this environment and on this computer** previews the scope, then clears shared local history, legacy caches and deduplication records, plus attributable collector caches, copied scripts and managed approval hooks in the current environment. Collection in that environment and local reception are paused afterward.
- **Clear all local notification caches only** works without a remote connection and does not remove server/container files.
- **Resume collection and reception** explicitly resumes processing of events after the cleanup cutoff. Removed approval hooks need to be configured, reviewed and trusted again in Codex.

Connect to and clean other SSH servers/containers separately. Unattributed old hook backups are reported and retained. System logs, terminal history, already displayed Windows notifications, disk snapshots and external backups are outside the extension's guaranteed cleanup scope. Older extension windows should be upgraded and reloaded, or they can continue writing old caches.

Cleanup preserves original Codex conversations, credentials, project files and unrelated hooks. Minimal pause controls without session identifiers and local communication identities remain to prevent old events replaying in other windows. This is application-data deletion, not secure disk erasure or guaranteed deletion from backups. The file scope is previewed before deletion. Unsafe paths, links or changed ownership cause rejection or an explicit incomplete result; partial cleanup is not reported as complete.

### Publication packages

Only VSIX files reviewed against an exact file allowlist, sensitive-content checks and SHA-256 verification are intended for publication. Runtime caches, generated test directories, account files, developer-machine paths and troubleshooting exports are excluded. Publisher identity, extension names, versions and packaged source code are visible to installers.
