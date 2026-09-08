# 0.3.4

## 0.4.1

- 新增公开 GitHub 仓库、双语首页、下载和问题反馈入口；运行逻辑与上一版本一致。
- Added the public GitHub repository, bilingual project page, downloads, and issue links. Runtime behavior is unchanged.

## 0.4.0

- 新增独立的中文／English 语言选择，默认中文；弹窗、日志和运行时说明随设置切换。切换不重启采集、不改变已读状态。
- Added independent Chinese/English runtime language selection, defaulting to Chinese. Popups, logs, and runtime labels follow the setting without restarting collection or changing read states.

- 补充完整中英文功能、安装、行为边界及隐私说明；命令和设置项增加双语解释。
- Add Chinese/English feature, installation, behavior and privacy documentation, with bilingual command labels and setting descriptions.
- 扩展身份、运行逻辑、设置默认值不变。 Extension identities, runtime behavior and setting defaults are unchanged.

# 0.3.3

- 默认回到 Codex 插件会话侧栏；新增菜单和 Open Location 设置，可选择主编辑器打开。
- 默认关闭窗口聚焦自动标读，点击仅标读被点击的通知；主动跳转期间暂停焦点／标签自动标读。
- 侧栏路径先聚焦目标窗口，避免 windowId 数字前缀路由，检测到焦点改变时保留未读。
- 明确侧栏路由请求与后端对话恢复确认的区别，保留显式自动标读偏好。

# 0.3.2

- 统一入口关联新的远端组件 ID `lengmo1996.codex-notifier-collector`，修复原市场条目删除后无法下载的问题。
- 补充旧远端组件卸载及新组件安装说明，保留现有采集与隐私行为。

# 0.3.1

- 主扩展更名为“Codex 会话通知”，统一安装入口关联配套远端采集器。
- 新增当前环境组件检查、扩展页面安装引导及缺失组件状态栏提示。
- 检查通过跨宿主命令识别远端组件，避免误判为未安装；不自动重载窗口或恢复暂停的采集。
- 保留现有提醒、标读、清理与当前用户通信隔离。

# 0.3.0

- 本机通信改为新身份与双向认证，限制当前用户访问，拒绝旧版明文握手。
- 新增通知缓存保留期、预览后清理和显式恢复；保留原始对话及无关配置。
- 补充隐私说明、共享账号边界与备份保留限制。
- 回复结束提示音默认开启，点击及标读继续静音。

# Changelog

## 0.2.0

- Accept only verified VS Code-origin sessions; ignore Desktop, CLI and unclassified legacy collector events.
- Embed local folder collection in the Windows UI extension. Remote Collector 0.1.1 runs only remotely.
- Acknowledge existing window notifications silently on returning to that window; selecting a Codex editor acknowledges only its session. Later arrivals stay unread.
- Add single-entry deletion, clear-read and clear-all actions; preserve deduplication and cancel pending delivery for deleted entries.
- Use broker protocol v4 with one-time history migration. Remote Collector 0.1.0 must be upgraded.

## 0.1.5

- Open the selected session as a Codex editor tab directly inside the broker-selected destination window.
- Verify the exact custom-editor tab is selected and explicitly focus its window through the local workbench command.
- Avoid global extension URI dispatch, which can route window ID 1 to window 16 in the tested VS Code 1.135.0 build and make remote sessions fail with "no rollout found".
- Keep navigation failures unread and clicks silent. Opening a tab acknowledges the reminder; it does not verify that the Codex backend has finished loading the conversation.
- Add a real VS Code custom-editor fixture test verifying the destination workspace, exact session URI and opened tab, plus a read-only reproduction of the installed URL router defect.

## 0.1.4

- Pulse the unread window-title dot every 800 ms while retaining completion/decision text and count; stop on acknowledgement, setting disable or disposal.
- Restart native taskbar flashing when a window with unread notifications moves into the background, including notifications received in the foreground.
- Preserve retries after native failures and reconnects; prevent outdated attention updates after read/disable changes during binding.
- Keep animation local to the window-title context with no notification sounds, settings writes or per-frame broker traffic.

## 0.1.3

- Add native per-window Windows taskbar yellow/red indicators and background flashing; add a completion/decision prefix to each window's taskbar preview title.
- Bind native windows using a temporary unique title nonce plus verified process, executable and window class; reject ambiguous or stale handles.
- Preserve custom title templates and update per-window context without repeated configuration writes.
- Remove the incorrect local extension-registry prerequisite for navigating to remote Codex sessions.
- Silence clicks immediately and mark read only after the destination accepts navigation; keep failures unread without replaying canceled sounds.
- Distinguish failed startup attempts from established broker disconnects.
- Use a v3 broker and migrate v2/v1 history without changing live older instances.

## 0.1.2

- Highlight the matching window's Codex status item: yellow for unread completion, red for approval or questions.
- Separate current-window unread, other-window unread and read history; add explicit labels and contrasting icons.
- Make history clicks silent acknowledgements and route them to the matching window and Codex session.
- Cancel pending alerts when acknowledged; briefly silence the window while its notifications are being handled.
- Route desktop notification clicks and preserve their exact notification identity.
- Use a separate v2 broker and migrate prior history once, allowing windows to update when idle.

## 0.1.0

- Initial private VSIX with completion, approval, structured question alerts and shared history.
