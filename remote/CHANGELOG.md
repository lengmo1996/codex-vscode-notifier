# 0.2.3

## 0.2.5

- 新增公开 GitHub 仓库、双语首页、下载和问题反馈入口；运行逻辑与上一版本一致。
- Added the public GitHub repository, bilingual project page, downloads, and issue links. Runtime behavior is unchanged.

## 0.2.4

- 新增独立的中文／English 语言选择，默认中文；弹窗、日志和运行时说明随设置切换。切换不重启采集、不改变已读状态。
- Added independent Chinese/English runtime language selection, defaulting to Chinese. Popups, logs, and runtime labels follow the setting without restarting collection or changing read states.

- 补充完整中英文功能、安装、行为边界及隐私说明；命令和设置项增加双语解释。
- Add Chinese/English feature, installation, behavior and privacy documentation, with bilingual command labels and setting descriptions.
- 扩展身份、运行逻辑、设置默认值不变。 Extension identities, runtime behavior and setting defaults are unchanged.

# 0.2.2

- 显示名称改为“Codex 远端通知采集器（lengmo1996）”，修复市场显示名称占用错误。
- 扩展 ID、运行时代码和主扩展关联不变。

# 0.2.1

- 更换市场 ID 为 `lengmo1996.codex-notifier-collector`；原名称删除后已被市场永久保留。
- 采集程序、命令、配置和数据目录保持不变；安装前请卸载目标环境中的旧远端扩展，避免冲突。

# 0.2.0

- 新增通知缓存保留期、预览后清理和显式恢复；保留原始对话及无关配置。
- 补充隐私说明、共享账号边界与备份保留限制。

# Changelog

## 0.1.1

- Restrict notifications to sessions whose first metadata record identifies codex_vscode; do not trust source=vscode alone.
- Revalidate hooks and legacy spool events, and attach verified provenance for UI 0.2.0 / broker v4.
- Keep subagent completion silent and retain explicit question/approval events.
- Do not activate in local windows; UI 0.2.0 embeds its own local collector.

## 0.1.0

- Initial private workspace collector.
