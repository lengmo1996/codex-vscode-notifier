#!/usr/bin/env python3
"""Prepare isolated host-test folders and print launch metadata; never launch VS Code."""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]


def find_code(explicit=None, environment=None):
    environment = os.environ if environment is None else environment
    candidate = explicit or environment.get("CODEX_NOTIFIER_VSCODE_EXECUTABLE")
    if candidate:
        path = Path(candidate)
        if not path.is_absolute() or not path.is_file():
            raise ValueError("--code / CODEX_NOTIFIER_VSCODE_EXECUTABLE must name an existing absolute executable")
        return path
    command = shutil.which("code", path=environment.get("PATH", ""))
    if command:
        path = Path(command)
        # Resolve only a discovered launcher location, never inspect user settings.
        if os.name == "nt" and path.suffix.lower() in {".cmd", ".bat"}:
            executable = path.parent.parent / "Code.exe"
            if executable.is_file():
                return executable
        elif path.is_file():
            return path
    raise ValueError("VS Code executable not found on PATH; provide --code or CODEX_NOTIFIER_VSCODE_EXECUTABLE")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--code", type=Path, help="Absolute VS Code executable; defaults to explicit environment then PATH discovery")
    parser.add_argument("--visual", action="store_true")
    parser.add_argument("--native-attention", action="store_true")
    parser.add_argument("--route-editor", action="store_true")
    args = parser.parse_args()
    code = find_code(args.code)
    visual = args.visual
    run_id = datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    runtime = ROOT / "packaging" / "host-runs" / run_id
    user_data = runtime / "user-data"
    extensions = runtime / "extensions"
    home = runtime / "codex-home"
    workspace = runtime / ("thermal-training" if visual else "workspace")
    for directory in (user_data / "User", extensions, home, workspace):
        directory.mkdir(parents=True, exist_ok=False)
    (home / ".codex-notifier-extension-test").write_text("isolated extension-host fixture\n", encoding="utf-8")
    settings = {
        "codexNotifier.localCodexHome": str(home), "codexNotifier.localCollectorEnabled": True,
        "extensions.confirmedUriHandlerExtensionIds": ["notifier-test.notifier-route-fixture"],
        "security.workspace.trust.enabled": False, "update.mode": "none",
        "extensions.autoCheckUpdates": False, "extensions.autoUpdate": False,
        "telemetry.telemetryLevel": "off", "workbench.startupEditor": "none",
        "window.restoreWindows": "none", "window.confirmBeforeClose": "never"
    }
    if visual:
        version = json.loads((ROOT / "ui" / "package.json").read_text(encoding="utf-8-sig"))["version"]
        settings.update({"window.title": "Codex Notifier " + version + " - Visual Review", "codexNotifier.localSourceLabel": "Local test workspace"})
    (user_data / "User" / "settings.json").write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    (home / "hooks.json").write_text(json.dumps({"hooks": {"PermissionRequest": [{"hooks": [{
        "type": "command", "command": "echo codex-notifier-unrelated-fixture", "timeout": 1
    }]}]}}, indent=2) + "\n", encoding="utf-8")
    session_id = str(uuid.uuid4())
    now = datetime.datetime.now(datetime.timezone.utc)
    day = home / "sessions" / now.strftime("%Y/%m/%d")
    day.mkdir(parents=True)
    rollout = day / ("rollout-" + now.strftime("%Y-%m-%dT%H-%M-%S") + "-" + session_id + ".jsonl")
    rollout.write_text(json.dumps({"timestamp": now.isoformat(), "type": "session_meta",
        "payload": {"id": session_id, "cwd": str(workspace), "originator": "codex_vscode", "source": "vscode"}}) + "\n", encoding="utf-8")
    metadata = {
        "code": str(code), "runtime": str(runtime),
        "env": {"CODEX_NOTIFIER_TEST_MODE": "1", "CODEX_NOTIFIER_TEST_HOME": str(home),
                "CODEX_NOTIFIER_TEST_ROLLOUT": str(rollout), "CODEX_NOTIFIER_TEST_SESSION": session_id,
                "CODEX_NOTIFIER_TEST_REPORT": str(runtime / "extension-host-report.json")},
        "args": ["--new-window", "--skip-welcome", "--skip-release-notes", "--disable-updates",
                 "--disable-telemetry", "--disable-workspace-trust",
                 "--user-data-dir=" + str(user_data), "--extensions-dir=" + str(extensions),
                 "--extensionDevelopmentPath=" + str(ROOT / "ui"),
                 "--extensionDevelopmentPath=" + str(ROOT / "remote"),
                 "--extensionTestsPath=" + str(ROOT / "tests" / "extension-host"), str(workspace)]
    }
    if visual:
        metadata["env"]["CODEX_NOTIFIER_VISUAL_REVIEW"] = "1"
    if args.native_attention:
        metadata["env"]["CODEX_NOTIFIER_ATTENTION_TEST"] = "1"
    if args.route_editor:
        metadata["env"]["CODEX_NOTIFIER_TEST_EDITOR"] = "1"
        metadata["args"].insert(-1, '--extensionDevelopmentPath=' + str(ROOT / 'tests' / 'route-editor-fixture'))
    (runtime / "launch.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metadata, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
