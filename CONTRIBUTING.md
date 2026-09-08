# 开发与贡献 / Contributing

欢迎提交复现清楚的问题和范围明确的改进。请勿提交私人路径、主机地址、真实会话、Codex Home、用户设置、测试运行目录或凭据。

Well-scoped improvements and reproducible reports are welcome. Never commit private paths, host addresses, real conversations, a Codex Home, user settings, generated test directories, or credentials.

## 本地验证 / Local checks

Use Windows with Node 22+ and Python for the full checks. Runtime JavaScript uses Node built-ins; Python collection and offline packaging use the standard library. 在 PowerShell 中从仓库根目录执行：

```powershell
python -B packaging/sync-local-collector.py --check
$notifierTests = Get-ChildItem tests -Filter '*.js' | Where-Object { $_.Name -ne 'tls-runtime-smoke.js' } | ForEach-Object { $_.FullName }
node --test --experimental-test-isolation=none $notifierTests
python -B tests/remote-collector.py
python -B tests/package-validation.py
```

Windows 通信测试需要正常当前用户权限和 PowerShell。不要为通过测试而禁用身份验证或放宽权限。 / Windows IPC tests need normal current-user permissions and PowerShell. Do not disable authentication or broaden permissions to pass tests.

修改采集器或共享翻译后同步内置副本 / Synchronize embedded copies after changing canonical collector sources or translations:

```powershell
python -B packaging/sync-local-collector.py
```

## 打包 / Packaging

```powershell
python -B build.py --output dist
```

离线包可用于本地测试。正式发布使用 `vsce package`，再用 `packaging/release-audit.py` 检查同一份包。新文件须经过审查并加入 `packaging/package_policy.py` 的明确文件清单。

Offline packages support local testing. For publication, package with `vsce package`, then audit those exact bytes with `packaging/release-audit.py`. Review new files and add them to the explicit list in `packaging/package_policy.py`.

真实宿主测试使用隔离合成数据，见 [packaging/README.md](packaging/README.md)。不要指向实际对话目录。 / Real host tests must use isolated synthetic fixtures, never real conversation directories.

保留会话来源过滤、当前用户通信认证、隐私清理确认和逐条标读行为。说明改动对本地、SSH 与容器模式的影响，以及实际完成的验证。

Preserve origin filtering, current-user IPC authentication, privacy cleanup confirmation, and per-notification read behavior. Describe effects on local, SSH, and container modes and checks actually performed. Clearly identify remote or visual tests that were not run.
