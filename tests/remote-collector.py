"""Behavior checks use temporary Codex homes; never access the user's config."""
import concurrent.futures
import datetime
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import shutil
import time
import unittest
import uuid

SCRIPT = Path(__file__).resolve().parents[1] / "remote" / "scripts" / "collector.py"
SPEC = importlib.util.spec_from_file_location("remote_notifier", SCRIPT)
REMOTE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REMOTE)


class RemoteTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Path(__file__).resolve().parent / ("tmp-" + uuid.uuid4().hex)
        self.fixture.mkdir()
        self.home = self.fixture / "codex home"
        self.home.mkdir()

    def tearDown(self):
        assert self.fixture.resolve().parent == Path(__file__).resolve().parent
        assert self.fixture.name.startswith("tmp-")
        shutil.rmtree(str(self.fixture))

    def run_cli(self, command, *args, payload=None):
        return subprocess.run([sys.executable, str(SCRIPT), command, "--codex-home", str(self.home), *args],
                              input=payload, capture_output=True, timeout=20)

    def read_events(self):
        path = self.home / "vscode-notifier" / "events.jsonl"
        return [json.loads(line) for line in path.read_bytes().splitlines()] if path.exists() else []

    def privacy_preview(self):
        result = self.run_cli("preview-privacy-cleanup")
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_privacy_cleanup_preserves_sessions_auth_other_hooks_and_unproven_backups(self):
        session = self.write_session("private-session")
        session_bytes = session.read_bytes()
        auth = self.home / "auth.json"
        auth.write_bytes(b'{"secret":"AUTH MUST STAY"}')
        hooks = self.home / "hooks.json"
        original = {"other": {"private": "preserve"}, "hooks": {"PermissionRequest": [
            {"hooks": [{"type": "command", "command": "echo unrelated"}]}]}}
        hooks.write_text(json.dumps(original), encoding="utf-8")
        legacy = self.home / "hooks.json.bak-20260101-000000-deadbeef"
        legacy.write_bytes(b"UNPROVEN OTHER TOOL BACKUP")
        self.assertEqual(self.run_cli("install").returncode, 0)
        self.assertEqual(self.run_cli("test").returncode, 0)
        directory = self.home / REMOTE.DIRECTORY_NAME
        unknown = directory / "user-notes.txt"
        unknown.write_bytes(b"KEEP USER FILE")
        temporary = directory / ("events.jsonl.tmp-" + "a" * 32)
        temporary.write_bytes(b"PRIVATE TEMPORARY")
        cache = directory / "__pycache__"
        cache.mkdir()
        (cache / "remote_notifier.cpython-314.pyc").write_bytes(b"OWNED BYTECODE")
        preview = self.privacy_preview()
        self.assertEqual(preview["legacyBackupCount"], 1)
        self.assertEqual(len(preview["trackedBackups"]), 1)
        self.assertTrue(preview["managedHookConfigured"])
        self.assertNotIn("AUTH MUST STAY", json.dumps(preview))
        cleared = self.run_cli("clear-private-data", "--preview-token", preview["previewToken"])
        self.assertEqual(cleared.returncode, 0, cleared.stderr)
        result = json.loads(cleared.stdout)
        self.assertTrue(result["cleared"])
        self.assertEqual(result["errors"], [])
        self.assertTrue(result["paused"])
        self.assertEqual(json.loads(hooks.read_bytes()), original)
        self.assertEqual(session.read_bytes(), session_bytes)
        self.assertEqual(auth.read_bytes(), b'{"secret":"AUTH MUST STAY"}')
        self.assertEqual(legacy.read_bytes(), b"UNPROVEN OTHER TOOL BACKUP")
        self.assertEqual({item.name for item in directory.iterdir()}, {REMOTE.PRIVACY_FILE, REMOTE.PRIVACY_LOCK, "user-notes.txt"})
        self.assertFalse((self.home / preview["trackedBackups"][0]).exists())
        state = json.loads((directory / REMOTE.PRIVACY_FILE).read_bytes())
        self.assertEqual(set(state), {"version", "paused", "cutoff"})

    def test_privacy_preview_is_read_only_and_stale_token_prevents_deletion(self):
        self.assertFalse((self.home / REMOTE.DIRECTORY_NAME).exists())
        empty = self.privacy_preview()
        self.assertFalse((self.home / REMOTE.DIRECTORY_NAME).exists())
        self.assertEqual(empty["files"], [])
        self.assertEqual(self.run_cli("test").returncode, 0)
        preview = self.privacy_preview()
        path = self.home / REMOTE.DIRECTORY_NAME / "events.jsonl"
        with path.open("ab") as stream:
            stream.write(b"changed after review\n")
        before = path.read_bytes()
        result = self.run_cli("clear-private-data", "--preview-token", preview["previewToken"])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse((path.parent / REMOTE.PRIVACY_FILE).exists())

    def test_privacy_corrupt_notifier_config_can_clear_but_corrupt_hooks_are_preserved(self):
        directory = self.home / REMOTE.DIRECTORY_NAME
        directory.mkdir()
        (directory / "config.json").write_bytes(b"corrupt private settings")
        preview = self.privacy_preview()
        result = self.run_cli("clear-private-data", "--preview-token", preview["previewToken"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((directory / "config.json").exists())
        hooks = self.home / "hooks.json"
        hooks.write_bytes(b"CORRUPT UNRELATED HOOKS")
        (directory / "config.json").write_bytes(b"keep on unsafe hook cleanup")
        preview = self.privacy_preview()
        self.assertFalse(preview["canClear"])
        result = self.run_cli("clear-private-data", "--preview-token", preview["previewToken"])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(hooks.read_bytes(), b"CORRUPT UNRELATED HOOKS")
        self.assertTrue((directory / "config.json").exists())

    def test_privacy_reset_blocks_hooks_replay_and_requires_explicit_resume(self):
        session = self.write_session("reset-session", records=[
            ("event_msg", {"type": "task_complete", "turn_id": "pre-reset"})])
        self.assertEqual(self.run_cli("test").returncode, 0)
        preview = self.privacy_preview()
        self.assertEqual(self.run_cli("clear-private-data", "--preview-token", preview["previewToken"]).returncode, 0)
        self.assertEqual(json.loads(self.run_cli("test").stdout)["queued"], False)
        hook = self.run_cli("hook", "--event", "approval", payload=json.dumps({"session_id": "reset-session"}).encode())
        self.assertEqual(hook.stdout.strip(), b"{}")
        paused = self.run_cli("follow", "--once")
        records = [json.loads(line) for line in paused.stdout.splitlines()]
        self.assertEqual([item["type"] for item in records], ["heartbeat"])
        self.assertTrue(records[0]["privacyPaused"])
        self.assertEqual({item.name for item in (self.home / REMOTE.DIRECTORY_NAME).iterdir()}, {REMOTE.PRIVACY_FILE, REMOTE.PRIVACY_LOCK})
        self.assertEqual(REMOTE.RolloutObserver(self.home, 300).poll(force=True), [])
        resumed = self.run_cli("resume-private-data")
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertEqual(REMOTE.RolloutObserver(self.home, 300).poll(force=True), [])
        with session.open("ab") as stream:
            stream.write(json.dumps({"timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "type": "event_msg", "payload": {"type": "task_complete", "turn_id": "post-reset"}}).encode() + b"\n")
        self.assertEqual([row["turn_id"] for row in REMOTE.RolloutObserver(self.home, 300).poll(force=True)], ["post-reset"])

    def test_notification_retention_prunes_only_owned_spools(self):
        directory = self.home / REMOTE.DIRECTORY_NAME
        directory.mkdir()
        records = []
        for age in (20, 8, 2):
            record, unused = REMOTE.event_record(self.home, "test")
            record["timestamp"] = time.time() - age * 86400
            record["id"] = "age-" + str(age)
            records.append(record)
        spool = directory / "events.jsonl"
        spool.write_bytes(b"".join(json.dumps(row).encode() + b"\n" for row in records))
        rotation = directory / "events.jsonl.1"
        rotation.write_bytes(json.dumps(records[0]).encode() + b"\n")
        untouched = self.home / "events.jsonl"
        untouched.write_bytes(b"NOT OUR CACHE")
        REMOTE.prune_notification_cache(self.home, 7)
        self.assertEqual([row["id"] for row in self.read_events()], ["age-2"])
        self.assertFalse(rotation.exists())
        self.assertEqual(untouched.read_bytes(), b"NOT OUR CACHE")
        REMOTE.prune_notification_cache(self.home, 1)
        self.assertFalse(spool.exists())
        for days in (0, -1, 31, 1.5, True):
            with self.assertRaises(ValueError):
                REMOTE.retention_days(days)

    def test_cleanup_rejects_unsafe_roots_traversal_and_linked_targets(self):
        for root in (Path(self.home.anchor), Path.home()):
            with self.assertRaises(ValueError):
                REMOTE.safe_home(root)
        for relative in ("../auth.json", str(self.fixture / "outside.json")):
            with self.assertRaises(ValueError):
                REMOTE.safe_path(self.home, relative)
        directory = self.home / REMOTE.DIRECTORY_NAME
        directory.mkdir()
        outside = self.fixture / "outside.json"
        outside.write_bytes(b"MUST NOT TOUCH")
        target = directory / "events.jsonl"
        os.link(outside, target)
        with self.assertRaises(ValueError):
            REMOTE.privacy_plan(self.home)
        self.assertEqual(outside.read_bytes(), b"MUST NOT TOUCH")
        target.unlink()
        try:
            target.symlink_to(outside)
        except OSError:
            return  # Hard-link rejection above is exercised on Windows without symlink privilege.
        with self.assertRaises(ValueError):
            REMOTE.privacy_plan(self.home)
        self.assertEqual(outside.read_bytes(), b"MUST NOT TOUCH")

    def write_session(self, session_id, originator="codex_vscode", source="vscode", records=()):
        directory = self.home / "sessions" / "2026" / "09" / "07"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / (session_id + ".jsonl")
        stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
        metadata = {"id": session_id, "cwd": "/project/a", "source": source}
        if originator is not None:
            metadata["originator"] = originator
        rows = [{"timestamp": stamp, "type": "session_meta", "payload": metadata}]
        rows.extend({"timestamp": stamp, "type": kind, "payload": payload} for kind, payload in records)
        path.write_bytes(b"".join(json.dumps(row).encode() + b"\n" for row in rows))
        return path

    def test_desktop_source_vscode_does_not_mean_the_vscode_extension(self):
        self.write_session("desktop-only", originator="Codex Desktop", records=[
            ("event_msg", {"type": "task_complete", "turn_id": "desktop-turn"}),
            ("response_item", {"type": "function_call", "name": "request_user_input", "call_id": "desktop-question"}),
        ])
        self.assertEqual(REMOTE.RolloutObserver(self.home, 300).poll(force=True), [])

    def test_hook_originator_without_verified_session_metadata_is_not_enough(self):
        result = self.run_cli("hook", "--event", "approval", payload=json.dumps({
            "session_id": "unknown", "originator": "codex_vscode", "source": "vscode"}).encode())
        self.assertEqual(result.stdout.strip(), b"{}")
        self.assertEqual(self.read_events(), [])

    def test_old_spool_is_rechecked_against_session_origin(self):
        self.write_session("desktop", originator="codex_work_desktop")
        self.write_session("extension")
        REMOTE.append_event(self.home, "approval", {"session_id": "desktop"})
        REMOTE.append_event(self.home, "approval", {"session_id": "extension"})
        REMOTE.append_event(self.home, "approval", {"session_id": "unknown"})
        output = self.run_cli("follow", "--once", "--no-rollouts")
        self.assertEqual(output.returncode, 0, output.stderr)
        records = [json.loads(line) for line in output.stdout.splitlines()]
        self.assertEqual([row["session_id"] for row in records if row["type"] == "approval"], ["extension"])
        self.assertEqual(records[-1]["originator"], "codex_vscode")
        self.assertNotIn("originator", records[0])

    def test_originator_allowlist_applies_to_completion_and_questions(self):
        originators = ["codex_vscode", "codex_work_desktop", "Codex Desktop", "codex_cli_rs",
                       None, "unknown-client", "codex_vscode_copilot", "CODEX_VSCODE", "codex_\nvscode", []]
        for index, originator in enumerate(originators):
            self.write_session("origin-" + str(index), originator=originator, records=[
                ("event_msg", {"type": "task_complete", "turn_id": "complete"}),
                ("response_item", {"type": "function_call", "name": "request_user_input", "call_id": "question"}),
            ])
        events = REMOTE.RolloutObserver(self.home, 300).poll(force=True)
        self.assertEqual([(row["session_id"], row["type"]) for row in events],
                         [("origin-0", "done"), ("origin-0", "question")])
        self.assertTrue(all(row["originator"] == "codex_vscode" for row in events))

    def test_hook_and_spool_filter_all_event_kinds_and_subagent_origins(self):
        child = {"subagent": {"thread_spawn": {"parent_thread_id": "root"}}}
        cases = [("vscode-root", "codex_vscode", "vscode", {"done", "question", "approval"}),
                 ("vscode-child", "codex_vscode", child, {"question", "approval"}),
                 ("app-root", "Codex Desktop", "vscode", set()),
                 ("app-child", "codex_work_desktop", child, set()),
                 ("cli-root", "codex_cli_rs", "cli", set()),
                 ("unknown", None, "vscode", set())]
        expected = set()
        for session_id, originator, source, allowed in cases:
            path = self.write_session(session_id, originator, source)
            for kind in ("done", "question", "approval"):
                payload = {"session_id": session_id, "transcript_path": str(path),
                           "tool_name": "request_user_input", "originator": "codex_vscode"}
                result = self.run_cli("hook", "--event", kind, payload=json.dumps(payload).encode())
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), b"{}")
                if kind in allowed:
                    expected.add((session_id, kind))
        self.assertEqual({(row["session_id"], row["type"]) for row in self.read_events()}, expected)
        self.assertTrue(all(row["originator"] == "codex_vscode" for row in self.read_events()))
        # Simulate an installed older hook that queues every source, with no
        # trusted provenance fields. The new follow must still filter it.
        event_path = self.home / "vscode-notifier" / "events.jsonl"
        event_path.write_bytes(b"")
        for session_id, unused_originator, unused_source, unused_allowed in cases:
            for kind in ("done", "question", "approval"):
                REMOTE.append_event(self.home, kind, {"session_id": session_id})
        replay = self.run_cli("follow", "--once", "--no-rollouts")
        self.assertEqual(replay.returncode, 0, replay.stderr)
        events = [json.loads(line) for line in replay.stdout.splitlines()]
        self.assertEqual({(row["session_id"], row["type"]) for row in events if row["type"] != "heartbeat"}, expected)
        self.assertTrue(all(row["originator"] == "codex_vscode" for row in events if row["type"] != "heartbeat"))

    def test_event_payload_cannot_claim_verified_originator(self):
        record, encoded = REMOTE.event_record(self.home, "approval", {"originator": "codex_vscode"})
        self.assertNotIn("originator", record)
        claimed = dict(record, originator="codex_vscode")
        self.assertNotIn("originator", REMOTE.valid_line(json.dumps(claimed).encode()))
        received = []
        spool = REMOTE.SourceCheckedSpool(REMOTE.SessionSources(self.home), received.append)
        spool.accept(json.dumps(claimed).encode())
        self.assertEqual(received, [])
        for kind in ("test", "heartbeat"):
            control, unused = REMOTE.event_record(self.home, kind)
            self.assertNotIn("originator", control)

    def test_hook_transcript_must_match_session_and_stay_in_selected_home(self):
        allowed = self.write_session("allowed")
        wrong = self.write_session("wrong", "Codex Desktop")
        outside = self.fixture / "outside.jsonl"
        outside.write_bytes(allowed.read_bytes())
        for payload in ({"session_id": "allowed", "transcript_path": str(wrong)},
                        {"session_id": "allowed", "transcript_path": str(outside)},
                        {"session_id": "allowed", "transcript_path": "relative.jsonl"},
                        {"session_id": "missing", "transcript_path": str(allowed)}):
            result = self.run_cli("hook", "--event", "approval", payload=json.dumps(payload).encode())
            self.assertEqual(result.stdout.strip(), b"{}")
        self.assertEqual(self.read_events(), [])
        valid = self.run_cli("hook", "--event", "approval", payload=json.dumps({
            "session_id": "allowed", "transcript_path": str(allowed)}).encode())
        self.assertEqual(valid.stdout.strip(), b"{}")
        self.assertEqual(len(self.read_events()), 1)

    def test_pre_filter_scan_state_is_revalidated_without_replaying_consumed_events(self):
        for session_id, originator in (("old-app", "Codex Desktop"), ("old-vscode", "codex_vscode")):
            path = self.write_session(session_id, originator, records=[
                ("event_msg", {"type": "task_complete", "turn_id": "already-read"}),
                ("event_msg", {"type": "task_complete", "turn_id": "unread"})])
            observer = REMOTE.RolloutObserver(self.home, 300)
            first_two = path.read_bytes().splitlines(keepends=True)[:2]
            observer.states[path] = {"offset": sum(map(len, first_two)), "identity": REMOTE.identity(path.stat()),
                                     "session_id": session_id, "cwd": "/project/a", "subagent": False,
                                     "discard": False, "originator": "codex_vscode"}
            events = observer.poll(force=True)
            self.assertEqual([row["turn_id"] for row in events], [] if originator != "codex_vscode" else ["unread"])
            self.assertEqual(observer.states[path]["originator"], originator)
            self.assertEqual(observer.states[path]["source_filter_version"], REMOTE.SOURCE_FILTER_VERSION)

    def test_source_cache_rechecks_changed_files_and_unknown_metadata(self):
        path = self.write_session("cached")
        sources = REMOTE.SessionSources(self.home)
        self.assertTrue(sources.allows("approval", {"session_id": "cached"}))
        before = path.stat()
        self.write_session("cached", "codex_cli_rs")
        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns + 1000000))
        self.assertFalse(sources.allows("approval", {"session_id": "cached"}))
        self.assertFalse(sources.allows("approval", {"session_id": "later"}))
        pending = REMOTE.SourceCheckedSpool(sources, lambda row: received.append(row))
        received = []
        record, encoded = REMOTE.event_record(self.home, "approval", {"session_id": "later"})
        pending.accept(encoded)
        self.assertEqual(received, [])
        self.assertIn(record["id"], pending.pending)
        self.write_session("later")
        sources.next_scan = 0
        pending.retry()
        self.assertEqual([row["session_id"] for row in received], ["later"])
        self.assertEqual(received[0]["originator"], "codex_vscode")
        self.assertEqual(pending.pending, {})
        unknown, unknown_bytes = REMOTE.event_record(self.home, "approval", {"session_id": "never-known"})
        pending.accept(unknown_bytes)
        pending.pending[unknown["id"]] = (unknown, time.monotonic() - 1)
        pending.retry()
        self.assertEqual([row["session_id"] for row in received], ["later"])
        self.assertEqual(pending.pending, {})

    def test_missing_or_oversized_metadata_is_quiet_and_partial_header_can_recover(self):
        path = self.write_session("partial", records=[("event_msg", {"type": "task_complete", "turn_id": "recovered"})])
        complete = path.read_bytes()
        path.write_bytes(complete[:20])
        observer = REMOTE.RolloutObserver(self.home, 300)
        self.assertEqual(observer.poll(force=True), [])
        with path.open("ab") as stream:
            stream.write(complete[20:])
        self.assertEqual([row["turn_id"] for row in observer.poll(force=True)], ["recovered"])
        oversized = self.write_session("oversized")
        metadata = json.loads(oversized.read_bytes())
        metadata["payload"]["private_instructions"] = "x" * REMOTE.MAX_METADATA_BYTES
        oversized.write_bytes(json.dumps(metadata).encode() + b"\n" + complete.splitlines(keepends=True)[-1])
        self.assertEqual([row["session_id"] for row in REMOTE.RolloutObserver(self.home, 300).poll(force=True)], ["partial"])
        self.assertIsNone(REMOTE.session_metadata(oversized))

    def test_large_valid_first_metadata_line_establishes_origin_without_forwarding_its_body(self):
        path = self.write_session("long-header", records=[
            ("event_msg", {"type": "task_complete", "turn_id": "done"})])
        lines = path.read_bytes().splitlines(keepends=True)
        metadata = json.loads(lines[0])
        metadata["payload"]["private_instructions"] = "PRIVATE" * 20000
        path.write_bytes(json.dumps(metadata).encode() + b"\n" + lines[-1])
        events = REMOTE.RolloutObserver(self.home, 300).poll(force=True)
        self.assertEqual([row["session_id"] for row in events], ["long-header"])
        self.assertNotIn("PRIVATE", json.dumps(events))

    def test_install_preserves_existing_and_is_idempotent_then_uninstalls_only_owned(self):
        original = {"description": "retain top-level", "hooks": {
            "Stop": [{"matcher": "abc", "hooks": [{"type": "command", "command": "echo keep"}]}],
            "SessionStart": [{"hooks": [{"type": "command", "command": "echo also-keep"}]}]}}
        path = self.home / "hooks.json"
        original_bytes = json.dumps(original).encode()
        path.write_bytes(original_bytes)
        installed = self.run_cli("install", "--label", "GPU 01 / 容器 A")
        self.assertEqual(installed.returncode, 0, installed.stderr)
        first_bytes = path.read_bytes()
        first = json.loads(first_bytes)
        self.assertEqual(first["description"], original["description"])
        self.assertEqual(first["hooks"]["Stop"][0], original["hooks"]["Stop"][0])
        self.assertEqual(first["hooks"]["SessionStart"], original["hooks"]["SessionStart"])
        self.assertEqual(len(first["hooks"]["Stop"]), 1)
        self.assertEqual(len(first["hooks"]["PermissionRequest"]), 1)
        self.assertEqual(json.loads(installed.stdout)["hook_count"], 1)
        self.assertEqual(len(list(self.home.glob("hooks.json.bak-*"))), 1)
        self.assertEqual(next(self.home.glob("hooks.json.bak-*")).read_bytes(), original_bytes)
        second = self.run_cli("install")
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(path.read_bytes(), first_bytes)
        self.assertEqual(len(list(self.home.glob("hooks.json.bak-*"))), 1)
        self.assertEqual(json.loads(second.stdout)["label"], "GPU 01 / 容器 A")
        self.assertEqual(self.run_cli("test").returncode, 0)
        removal = self.run_cli("uninstall")
        self.assertEqual(removal.returncode, 0, removal.stderr)
        self.assertEqual(json.loads(path.read_bytes()), original)
        self.assertEqual(len(self.read_events()), 1)
        self.assertTrue((self.home / "vscode-notifier" / "remote_notifier.py").exists())

    def test_invalid_existing_configuration_is_unchanged(self):
        path = self.home / "hooks.json"
        for data in (b"bad-json", b'[]', b'{"hooks": []}', b'{"hooks":{"Stop": {}}}'):
            path.write_bytes(data)
            outcome = self.run_cli("install")
            self.assertNotEqual(outcome.returncode, 0)
            self.assertEqual(path.read_bytes(), data)
        self.assertFalse((self.home / "vscode-notifier" / "config.json").exists())

    def test_hook_metadata_privacy_and_failure_never_control_approval(self):
        self.write_session("s1")
        self.run_cli("install", "--label", "gpu-01")
        payload = {"session_id": "s1", "turn_id": "t2", "cwd": "/project/a", "tool_name": "shell",
                   "prompt": "private prompt", "tool_input": {"command": "private command"}}
        result = self.run_cli("hook", "--event", "approval", payload=json.dumps(payload).encode())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), b"{}")
        events = self.read_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "approval")
        self.assertEqual(events[0]["cwd"], "/project/a")
        self.assertEqual(events[0]["label"], "gpu-01")
        self.assertNotIn("private", json.dumps(events))
        for invalid in (b"not json", b"[]", b"a" * (1024 * 1024 + 1)):
            failure = self.run_cli("hook", "--event", "done", payload=invalid)
            self.assertEqual(failure.returncode, 0)
            self.assertEqual(failure.stdout.strip(), b"{}")
            self.assertTrue(failure.stderr)
        self.assertEqual(len(self.read_events()), 1)

    def test_question_only_matches_input_tools_and_handles_long_unicode(self):
        self.write_session("s")
        for name in ("shell", "request_user_input", "request_user_input_async"):
            result = self.run_cli("hook", "--event", "question", payload=json.dumps({
                "tool_name": name, "cwd": "😀" * 10000, "session_id": "s"}).encode())
            self.assertEqual(result.returncode, 0)
        events = self.read_events()
        self.assertEqual(len(events), 2)
        self.assertTrue(all(record["type"] == "question" for record in events))
        for line in (self.home / "vscode-notifier" / "events.jsonl").read_bytes().splitlines(keepends=True):
            self.assertLessEqual(len(line), 4096)

    def test_parallel_process_append_integrity(self):
        for index in range(48):
            self.write_session(str(index))
        def write(index):
            return self.run_cli("hook", "--event", "done", payload=json.dumps({"session_id": str(index)}).encode())
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(write, range(48)))
        self.assertTrue(all(result.returncode == 0 and not result.stderr for result in results),
                        [result.stderr for result in results if result.stderr])
        events = self.read_events()
        self.assertEqual(len(events), 48)
        self.assertEqual(len({event["id"] for event in events}), 48)
        self.assertEqual({event["session_id"] for event in events}, {str(index) for index in range(48)})

    def test_rotation_and_follow_replay_ignore_old_corrupt_and_extra_fields(self):
        self.write_session("verified-replay")
        directory = self.home / "vscode-notifier"
        directory.mkdir()
        path = directory / "events.jsonl"
        old, unused = REMOTE.event_record(self.home, "done")
        old["timestamp"] = time.time() - 1000
        recent, unused = REMOTE.event_record(self.home, "approval", {"session_id": "verified-replay"})
        recent["private_prompt"] = "must not be relayed"
        path.write_bytes(json.dumps(old).encode() + b"\ncorrupted line\n" +
                         json.dumps(recent).encode() + b"\n")
        output = self.run_cli("follow", "--once")
        self.assertEqual(output.returncode, 0, output.stderr)
        records = [json.loads(line) for line in output.stdout.splitlines()]
        self.assertEqual([record["type"] for record in records], ["heartbeat", "approval"])
        self.assertNotIn("private_prompt", records[-1])
        with path.open("ab") as stream:
            stream.write(b"x" * (5 * 1024 * 1024))
        self.assertEqual(self.run_cli("test").returncode, 0)
        self.assertTrue((directory / "events.jsonl.1").exists())
        self.assertLess(path.stat().st_size, 4096)
        replay = self.run_cli("follow", "--once")
        self.assertEqual([json.loads(line)["type"] for line in replay.stdout.splitlines()], ["heartbeat", "test"])

    def test_follow_observes_append_and_rotation(self):
        self.write_session("follow-hook")
        directory = self.home / "vscode-notifier"
        directory.mkdir()
        captured = self.fixture / "follow.jsonl"
        errors = self.fixture / "follow-errors.txt"
        with captured.open("wb") as output, errors.open("wb") as error_output:
            process = subprocess.Popen([sys.executable, str(SCRIPT), "follow", "--codex-home", str(self.home)],
                                       stdout=output, stderr=error_output)
            try:
                self.wait_for(captured, 1)
                self.assertEqual(self.run_cli("test").returncode, 0)
                self.wait_for(captured, 2)
                path = directory / "events.jsonl"
                with REMOTE.locked(directory / ".events.lock"):
                    os.replace(str(path), str(directory / "events.jsonl.1"))
                self.assertEqual(self.run_cli("hook", "--event", "done", payload=b'{"session_id":"follow-hook"}').returncode, 0)
                self.wait_for(captured, 3)
            finally:
                process.terminate()
                process.wait(timeout=10)
        records = [json.loads(line) for line in captured.read_bytes().splitlines()]
        self.assertEqual([record["type"] for record in records], ["heartbeat", "test", "done"])
        self.assertEqual(errors.read_bytes(), b"")

    def test_rollout_completion_questions_privacy_replay_and_incremental_read(self):
        directory = self.home / "sessions" / datetime.date.today().strftime("%Y/%m/%d")
        directory.mkdir(parents=True)
        path = directory / "rollout-2026-01-01T00-00-00-12345678-1234-1234-1234-123456789abc.jsonl"
        recent_time = datetime.datetime.now(datetime.timezone.utc).isoformat()
        stale_time = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=1)).isoformat()
        def outer(typ, payload, timestamp=recent_time):
            return json.dumps({"timestamp": timestamp, "type": typ, "payload": payload}).encode() + b"\n"
        metadata = outer("session_meta", {"id": "session-1", "cwd": "/training/project", "originator": "codex_vscode"})
        stale = outer("event_msg", {"type": "task_complete", "turn_id": "stale"}, stale_time)
        done = outer("event_msg", {"type": "task_complete", "turn_id": "turn-1", "last_agent_message": "PRIVATE"})
        question = outer("response_item", {"type": "function_call", "name": "request_user_input_async",
                                          "call_id": "call-1", "arguments": "PRIVATE"})
        ignored = outer("response_item", {"type": "function_call", "name": "shell", "arguments": "PRIVATE"})
        path.write_bytes(metadata + stale + done + question + ignored)
        observer = REMOTE.RolloutObserver(self.home, 300)
        first = observer.poll(force=True)
        self.assertEqual([record["type"] for record in first], ["done", "question"])
        self.assertTrue(all(record["cwd"] == "/training/project" for record in first))
        self.assertEqual(first[0]["turn_id"], "turn-1")
        self.assertNotIn("PRIVATE", json.dumps(first))
        self.assertEqual(observer.poll(force=True), [])
        self.assertEqual([record["id"] for record in REMOTE.RolloutObserver(self.home, 300).poll(force=True)],
                         [record["id"] for record in first])
        with path.open("ab") as stream:
            stream.write(outer("event_msg", {"type": "task_complete", "turn_id": "turn-2"}))
        added = observer.poll(force=True)
        self.assertEqual(len(added), 1)
        self.assertEqual(added[0]["turn_id"], "turn-2")
        self.assertNotEqual(added[0]["id"], first[0]["id"])
        replay = self.run_cli("follow", "--once")
        self.assertEqual(replay.returncode, 0, replay.stderr)
        self.assertEqual([json.loads(line)["type"] for line in replay.stdout.splitlines()],
                         ["heartbeat", "done", "question", "done"])

    def test_installed_script_follows_its_own_home(self):
        self.assertEqual(self.run_cli("install").returncode, 0)
        self.assertEqual(self.run_cli("test").returncode, 0)
        installed = self.home / "vscode-notifier" / "remote_notifier.py"
        wrong_home = self.fixture / "wrong-home"
        outcome = subprocess.run([sys.executable, str(installed), "follow", "--once"],
                                 env={**os.environ, "CODEX_HOME": str(wrong_home)},
                                 capture_output=True, timeout=10)
        self.assertEqual(outcome.returncode, 0, outcome.stderr)
        self.assertEqual([json.loads(line)["type"] for line in outcome.stdout.splitlines()],
                         ["heartbeat", "test"])
        self.assertFalse(wrong_home.exists())

    def test_resumed_old_session_directory_is_discovered_by_recent_mtime(self):
        old_day = datetime.date.today() - datetime.timedelta(days=3)
        directory = self.home / "sessions" / old_day.strftime("%Y/%m/%d")
        directory.mkdir(parents=True)
        active = directory / "resumed-old-task.jsonl"
        cold = directory / "unchanged-old-task.jsonl"
        timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
        metadata = {"timestamp": timestamp, "type": "session_meta", "payload": {
            "id": "old-but-active-session", "cwd": "/resumed/project", "originator": "codex_vscode"}}
        completion = {"timestamp": timestamp, "type": "event_msg", "payload": {
            "type": "task_complete", "turn_id": "new-turn"}}
        active.write_bytes(json.dumps(metadata).encode() + b"\n" + json.dumps(completion).encode() + b"\n")
        cold.write_bytes(b"PRIVATE HISTORICAL BODY; DO NOT READ")
        old_mtime = time.time() - 3 * 24 * 3600
        os.utime(str(cold), (old_mtime, old_mtime))
        observer = REMOTE.RolloutObserver(self.home, 300)
        events = observer.poll(force=True)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["session_id"], "old-but-active-session")
        self.assertEqual(events[0]["type"], "done")
        self.assertIn(active, observer.states)
        self.assertNotIn(cold, observer.states)
        self.assertGreater(observer.next_scan - time.monotonic(), 8)

    def test_subagent_completion_is_quiet_but_user_question_is_preserved(self):
        directory = self.home / "sessions"
        directory.mkdir()
        path = directory / "subagent.jsonl"
        timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
        def outer(kind, payload):
            return json.dumps({"timestamp": timestamp, "type": kind, "payload": payload}).encode() + b"\n"
        metadata = outer("session_meta", {"id": "subagent-session", "cwd": "/training/project", "originator": "codex_vscode",
                         "source": {"subagent": {"thread_spawn": {"parent_thread_id": "root"}}}})
        done = outer("event_msg", {"type": "task_complete", "turn_id": "subagent-turn"})
        question = outer("response_item", {"type": "function_call", "name": "request_user_input",
                                           "call_id": "subagent-question"})
        # Force initial tailing to rely on the separate metadata read.
        padding = outer("response_item", {"text": "x" * REMOTE.ROLLOUT_TAIL_BYTES})
        path.write_bytes(metadata + padding + done + question)
        events = REMOTE.RolloutObserver(self.home, 300).poll(force=True)
        self.assertEqual([event["type"] for event in events], ["question"])
        root_metadata = outer("session_meta", {"id": "root", "cwd": "/training/project", "source": "vscode", "originator": "codex_vscode"})
        path.write_bytes(root_metadata + done)
        self.assertEqual([event["type"] for event in REMOTE.RolloutObserver(self.home, 300).poll(force=True)], ["done"])

    @unittest.skipUnless(os.name == "nt", "Windows hook shell override")
    def test_windows_hook_override_executes_with_redirected_stdin(self):
        self.write_session("windows-hook")
        installed = self.run_cli("install")
        self.assertEqual(installed.returncode, 0, installed.stderr)
        definition = json.loads((self.home / "hooks.json").read_bytes())["hooks"]["PermissionRequest"][0]["hooks"][0]
        result = subprocess.run(definition["commandWindows"], shell=True,
                                input=b'{"session_id":"windows-hook","turn_id":"turn"}',
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), b"{}")
        self.assertEqual(self.read_events()[-1]["session_id"], "windows-hook")
        self.assertEqual(self.read_events()[-1]["type"], "approval")

    @staticmethod
    def wait_for(path, minimum_lines):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if len(path.read_bytes().splitlines()) >= minimum_lines:
                return
            time.sleep(0.05)
        raise AssertionError("Timed out waiting for follow output")


if __name__ == "__main__":
    unittest.main(verbosity=2)

