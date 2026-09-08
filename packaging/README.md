# Offline packaging and isolated extension-host checks

`build.py` creates two VSIX archives using Python's standard library, then verifies ZIP integrity,
VSIX identity and engine metadata, the package manifest asset and the executable entry point.
It never installs extensions or accesses the network. The narrow format follows Microsoft's
[`vscode-vsce` VSIX writer](https://github.com/microsoft/vscode-vsce/blob/main/src/package.ts).
No Marketplace signature is added: these are locally built, sideloaded extensions.

From `work/vscode-notifier`:

```powershell
py -3 -B tests/package-validation.py
py -3 -B build.py
py -3 -B build.py --verify-only
```

The output defaults to the repository's `dist` directory. Inputs can be changed
using `--ui`, `--remote`, and `--output`. No npm dependencies are fetched or bundled.

## Real VS Code extension-host test

Run `py -3 -B packaging/prepare-host-test.py` first. It writes a fresh, isolated user-data directory,
extensions directory, workspace and Codex home below `packaging/host-runs`, then prints a JSON launch
descriptor and saves it as `launch.json`. It does not start a GUI.

Use its `code`, `args` and `env` fields to start a child process. Pass every argument as a separate
argument, without constructing a shell command. In particular the two repeated arguments are:

```text
--extensionDevelopmentPath=<absolute work/vscode-notifier/ui>
--extensionDevelopmentPath=<absolute work/vscode-notifier/remote>
--extensionTestsPath=<absolute work/vscode-notifier/tests/extension-host>
--user-data-dir=<isolated user-data>
--extensions-dir=<isolated extensions>
```

The native test runner loads `index.js` and awaits its exported `run` function. It uses Node's
standard assertions, without Mocha or downloaded test tools. The parent process should preserve
the existing environment, apply the descriptor's test environment values, and unset
`ELECTRON_RUN_AS_NODE` for the child only. On Windows launch the child hidden unless a visible
interactive test was explicitly requested. When launching through Python, use a `Popen` argument
list, `CREATE_NO_WINDOW` and `STARTUPINFO` with `SW_HIDE` as applicable; the real app may still
create a test workbench while the extension host runs.

The test mode disables native notification side effects. The suite activates both extensions,
checks event history, unread counts and deduplication, pause/resume, public commands, idempotent
approval hook installation preserving an unrelated hook, and the actual collector-to-UI command
bridge using temporary event and rollout files. It writes `extension-host-report.json` in the
isolated run directory. Exit code zero and `failed: 0` are both required for a successful run.

This verifies the **local** VS Code extension host. It does not verify an SSH/container extension
host or whether a person visually saw a Windows notification. Those need separate smoke tests.
