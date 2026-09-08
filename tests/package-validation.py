#!/usr/bin/env python3
"""Offline regression tests for the VSIX writer and structural verifier."""
import importlib.util
import hashlib
import itertools
import json
from pathlib import Path
import shutil
import unittest
from unittest import mock
import uuid
import warnings
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("notifier_build", ROOT / "build.py")
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)
policy = __import__("package_policy")


def load_tool(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "packaging" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bundle = load_tool("notifier_bundle_test", "bundle-source.py")
audit = load_tool("notifier_audit_test", "release-audit.py")
host = load_tool("notifier_host_test", "prepare-host-test.py")


class PackageTests(unittest.TestCase):
    def setUp(self):
        # Default Windows inherited ACLs avoid Python 3.14's restrictive tempfile ACL.
        self.runtime_root = (ROOT / "packaging" / "package-test-runs").resolve()
        self.runtime = self.runtime_root / uuid.uuid4().hex
        self.source = self.runtime / "source"
        self.source.mkdir(parents=True)
        self.output = self.runtime / "output"
        self.package = {"name": "codex-notifier-ui", "publisher": "lengmo1996", "version": build.VERSIONS["ui"],
                        "engines": {"vscode": "^1.96.0"}, "main": "./extension.js",
                        "displayName": "Codex & 通知 <local>", "description": "Offline test",
                        "extensionKind": ["ui"], "extensionPack": ["lengmo1996.codex-notifier-collector"]}
        self.fill_files(self.source, policy.EXTENSION_FILES["ui"])
        self.write_package()
        (self.source / "extension.js").write_text("exports.activate = function () {};\n", encoding="utf-8")
        (self.source / "README.md").write_text("# Test package\n", encoding="utf-8")

    def tearDown(self):
        target = self.runtime.resolve()
        # Guard recursive cleanup against directory computation mistakes.
        if target.parent != self.runtime_root or not target.name.isalnum():
            raise RuntimeError("Refusing cleanup outside package-test-runs")
        shutil.rmtree(target)

    def write_package(self):
        (self.source / "package.json").write_text(json.dumps(self.package), encoding="utf-8")

    def fill_files(self, directory, names):
        for name in names:
            path = directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("reviewed fixture\n", encoding="utf-8")

    def rewrite_archive(self, path, transform):
        with zipfile.ZipFile(path) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        transform(files)
        with zipfile.ZipFile(path, "w") as archive:
            for name, data in files.items():
                archive.writestr(name, data)

    def apply_document_names(self, files, mapping):
        for old, new in mapping.items():
            files[new] = files.pop(old)
        for metadata in ("extension.vsixmanifest", "[Content_Types].xml"):
            for old, new in mapping.items():
                files[metadata] = files[metadata].replace(old.encode(), new.encode())

    def test_complete_official_document_names_are_accepted(self):
        result = build.build_one(self.source, self.output, "ui")
        self.rewrite_archive(result["path"], lambda files: self.apply_document_names(files, build.VSCE_DOCUMENT_NAMES))
        report = build.verify_vsix(result["path"], "ui")
        names = {item["path"] for item in report["members"]}
        self.assertTrue(set(build.VSCE_DOCUMENT_NAMES.values()) <= names)
        self.assertFalse(set(build.VSCE_DOCUMENT_NAMES) & names)
        self.assertEqual(report["sha256"], hashlib.sha256(Path(result["path"]).read_bytes()).hexdigest())

    def test_unreviewed_pack_members_and_cross_host_dependencies_are_rejected(self):
        for changes in ({"extensionPack": []}, {"extensionPack": ["someone.unreviewed"]},
                        {"extensionDependencies": ["lengmo1996.codex-notifier-collector"]}):
            with self.assertRaisesRegex(ValueError, "extensionPack"):
                build.validate_package(dict(self.package, **changes), "ui")

    def test_vsix_pack_metadata_tampering_is_rejected(self):
        result = build.build_one(self.source, self.output, "ui")
        def change(files):
            files["extension.vsixmanifest"] = files["extension.vsixmanifest"].replace(
                b'Value="lengmo1996.codex-notifier-collector"', b'Value="someone.unreviewed"')
        self.rewrite_archive(result["path"], change)
        with self.assertRaisesRegex(ValueError, "ExtensionPack"):
            build.verify_vsix(result["path"], "ui")

    def test_mixed_document_name_sets_are_rejected(self):
        for count in (1, 2):
            for selected in itertools.combinations(build.VSCE_DOCUMENT_NAMES, count):
                result = build.build_one(self.source, self.output, "ui")
                mapping = {name: build.VSCE_DOCUMENT_NAMES[name] for name in selected}
                self.rewrite_archive(result["path"], lambda files: self.apply_document_names(files, mapping))
                with self.subTest(renamed=selected), self.assertRaisesRegex(ValueError, "allowlist"):
                    build.verify_vsix(result["path"], "ui")

    def test_official_names_reject_extra_case_aliases_and_duplicates(self):
        for extra in ("extension/LICENSE", "extension/README.md", "extension/license.txt",
                      "extension/readme.md", "extension/../readme.md", "extension/private-notes.txt"):
            result = build.build_one(self.source, self.output, "ui")
            self.rewrite_archive(result["path"], lambda files: self.apply_document_names(files, build.VSCE_DOCUMENT_NAMES))
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                with zipfile.ZipFile(result["path"], "a") as archive:
                    archive.writestr(extra, b"unreviewed")
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                build.verify_vsix(result["path"], "ui")

    def test_official_document_content_is_still_scanned(self):
        result = build.build_one(self.source, self.output, "ui")
        self.rewrite_archive(result["path"], lambda files: self.apply_document_names(files, build.VSCE_DOCUMENT_NAMES))
        secret = ("-----BEGIN " + "RSA PRIVATE KEY-----").encode()
        self.rewrite_archive(result["path"], lambda files: files.update({"extension/readme.md": secret}))
        with self.assertRaisesRegex(ValueError, "private-key"):
            build.verify_vsix(result["path"], "ui")

    def test_archive_has_standard_metadata_and_readme_asset(self):
        result = build.build_one(self.source, self.output, "ui")
        self.assertEqual(result["extension_id"], "lengmo1996.codex-notifier-ui")
        with zipfile.ZipFile(result["path"]) as archive:
            manifest = ET.fromstring(archive.read("extension.vsixmanifest"))
            display = manifest.find("v:Metadata/v:DisplayName", {"v": build.NS})
            self.assertEqual(display.text, self.package["displayName"])
            readme = manifest.find("v:Assets/v:Asset[@Type='Microsoft.VisualStudio.Services.Content.Details']", {"v": build.NS})
            self.assertEqual(readme.get("Path"), "extension/README.md")
            self.assertEqual(archive.testzip(), None)

    def test_same_sources_produce_same_bytes(self):
        first = build.build_one(self.source, self.output, "ui")
        second = build.build_one(self.source, self.output, "ui")
        self.assertEqual(first["sha256"], second["sha256"])

    def test_path_traversal_main_is_rejected(self):
        self.package["main"] = "../outside.js"
        self.write_package()
        with self.assertRaises(ValueError):
            build.build_one(self.source, self.output, "ui")

    def test_missing_main_is_rejected(self):
        self.package["main"] = "./missing.js"
        self.write_package()
        with self.assertRaises(ValueError):
            build.build_one(self.source, self.output, "ui")

    def test_identity_and_runtime_dependency_mismatch_are_rejected(self):
        for change in ({"publisher": "other"}, {"dependencies": {"unpackaged": "1.0.0"}},
                       {"extensionKind": ["workspace"]}, {"engines": {"vscode": "*"}}):
            modified = dict(self.package)
            modified.update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                build.validate_package(modified, "ui")

    def test_known_development_directories_are_not_traversed(self):
        (self.source / "tests").mkdir()
        (self.source / "tests" / "sensitive-fixture.json").write_text("{}", encoding="utf-8")
        cache = self.source / "collector" / "scripts" / "__pycache__"
        cache.mkdir()
        (cache / "cache.pyc").write_bytes(b"not source")
        result = build.build_one(self.source, self.output, "ui")
        with zipfile.ZipFile(result["path"]) as archive:
            self.assertEqual(set(archive.namelist()), {"extension/" + name for name in policy.EXTENSION_FILES["ui"]}
                             | {"extension.vsixmanifest", "[Content_Types].xml"})

    def test_unreviewed_files_and_runtime_files_fail_closed(self):
        for name in ("private-notes.txt", "lib/unreviewed.js", "debug.log", "old.vsix",
                     "auth.json", "broker-token", "private.pem", ".env.production"):
            path = self.source / name
            path.write_text("fixture", encoding="utf-8")
            with self.subTest(name=name), self.assertRaises(ValueError):
                build.build_one(self.source, self.output, "ui")
            path.unlink()

    def test_missing_reviewed_library_is_rejected(self):
        (self.source / "lib" / "client.js").unlink()
        with self.assertRaisesRegex(ValueError, "Missing reviewed"):
            build.build_one(self.source, self.output, "ui")

    def test_environment_file_is_rejected(self):
        (self.source / ".env.production").write_text("TOKEN=fixture", encoding="utf-8")
        with self.assertRaises(ValueError):
            build.build_one(self.source, self.output, "ui")

    def test_tampered_manifest_identity_is_rejected(self):
        result = build.build_one(self.source, self.output, "ui")
        package_path = Path(result["path"])
        with zipfile.ZipFile(package_path) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        files["extension.vsixmanifest"] = files["extension.vsixmanifest"].replace(b'Publisher="lengmo1996"', b'Publisher="attacker"')
        with zipfile.ZipFile(package_path, "w") as archive:
            for name, data in files.items():
                archive.writestr(name, data)
        with self.assertRaises(ValueError):
            build.verify_vsix(package_path, "ui")

    def test_added_archive_member_is_rejected(self):
        result = build.build_one(self.source, self.output, "ui")
        self.rewrite_archive(result["path"], lambda files: files.update({"extension/private-notes.txt": b"private"}))
        with self.assertRaisesRegex(ValueError, "allowlist"):
            build.verify_vsix(result["path"], "ui")

    def test_private_key_and_developer_paths_are_rejected_without_echo(self):
        samples = ["-----BEGIN " + "OPENSSH PRIVATE KEY-----", "C:" + "/" + "Users/private-author/project",
                   "C" + r":\Users\private-author\project", "C" + r":\\Users\\private-author\\project",
                   "/" + "home/private-author/project", "/" + "Users/private-author/project",
                   "/" + "root/private-project", "D" + ":/private-project"]
        for content in samples:
            (self.source / "README.md").write_text(content, encoding="utf-8")
            with self.subTest(content=content), self.assertRaises(ValueError) as raised:
                build.build_one(self.source, self.output, "ui")
            self.assertNotIn("private-author", str(raised.exception))

    def test_tampered_allowed_member_is_scanned(self):
        result = build.build_one(self.source, self.output, "ui")
        secret = ("-----BEGIN " + "RSA PRIVATE KEY-----").encode()
        self.rewrite_archive(result["path"], lambda files: files.update({"extension/README.md": secret}))
        with self.assertRaisesRegex(ValueError, "private-key"):
            build.verify_vsix(result["path"], "ui")

    def test_members_have_exact_individual_hashes(self):
        result = build.build_one(self.source, self.output, "ui")
        with zipfile.ZipFile(result["path"]) as archive:
            for item in result["members"]:
                data = archive.read(item["path"])
                self.assertEqual(item["bytes"], len(data))
                self.assertEqual(item["sha256"], hashlib.sha256(data).hexdigest())

    def test_archive_symlink_mode_is_rejected(self):
        result = build.build_one(self.source, self.output, "ui")
        path = result["path"]
        with zipfile.ZipFile(path) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        with zipfile.ZipFile(path, "w") as archive:
            for name, data in files.items():
                info = zipfile.ZipInfo(name)
                info.create_system = 3
                info.external_attr = (0o120777 if name == "extension/README.md" else 0o100644) << 16
                archive.writestr(info, data)
        with self.assertRaisesRegex(ValueError, "link"):
            build.verify_vsix(path, "ui")

    def test_windows_reparse_attribute_is_rejected(self):
        fake = type("FileStat", (), {"st_mode": 0o100644, "st_file_attributes": 0x400})()
        with mock.patch.object(Path, "lstat", return_value=fake):
            with self.assertRaisesRegex(ValueError, "reparse"):
                policy.reject_link(self.source / "README.md")

    def test_noncanonical_archive_paths_are_rejected(self):
        for name in ("../outside", "/absolute", "./extension/file", "extension//file",
                     "extension/../file", "C" + ":/file", "extension\\file", "extension/file:stream"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                policy.canonical_member(name)

    def test_source_bundle_is_deterministic_and_excludes_host_runtime(self):
        source = self.runtime / "repo"
        self.fill_files(source, policy.SOURCE_FILES)
        private = source / "packaging" / "host-runs" / "fixture" / "auth.json"
        private.parent.mkdir(parents=True)
        private.write_text("not for publication", encoding="utf-8")
        destination = self.output / "source.zip"
        first = bundle.bundle_source(source, destination)
        second = bundle.bundle_source(source, destination)
        self.assertEqual(first["sha256"], second["sha256"])
        self.assertEqual({item["path"] for item in first["members"]},
                         {bundle.PREFIX + name for name in policy.SOURCE_FILES})

    def test_source_bundle_rejects_private_extra_file(self):
        source = self.runtime / "repo"
        self.fill_files(source, policy.SOURCE_FILES)
        for name in ("notes-private.txt", "ui/auth.json", "packaging/unreviewed.py"):
            path = source / name
            path.write_text("fixture", encoding="utf-8")
            with self.subTest(name=name), self.assertRaises(ValueError):
                bundle.bundle_source(source, self.output / "source.zip")
            path.unlink()

    def test_reviewed_test_paths_do_not_allow_other_developer_paths(self):
        name = "tests/broker-core.js"
        policy.check_content(name, ("/" + "home/user").encode(), source=True)
        with self.assertRaisesRegex(ValueError, "developer path"):
            policy.check_content(name, ("/" + "home/private-author").encode(), source=True)
        with self.assertRaisesRegex(ValueError, "developer path"):
            policy.check_content("README.md", ("/" + "home/user").encode(), source=True)

    def test_release_audit_binds_both_reviewed_hashes_without_publishing(self):
        ui = build.build_one(self.source, self.output, "ui")
        remote_root = self.runtime / "remote"
        self.fill_files(remote_root, policy.EXTENSION_FILES["remote"])
        package = dict(self.package, name=build.IDS["remote"], version=build.VERSIONS["remote"],
                       main="./src/extension.js", extensionKind=["workspace"], extensionPack=[])
        (remote_root / "package.json").write_text(json.dumps(package), encoding="utf-8")
        remote = build.build_one(remote_root, self.output, "remote")
        initial = audit.audit_release(ui["path"], remote["path"])
        self.assertFalse(initial["uploaded"])
        self.assertFalse(initial["credentials_accessed"])
        self.assertFalse(initial["all_reviewed_hashes_matched"])
        final = audit.audit_release(ui["path"], remote["path"],
                                    expected={"ui": ui["sha256"], "remote": remote["sha256"]})
        self.assertTrue(final["all_reviewed_hashes_matched"])
        with self.assertRaisesRegex(ValueError, "SHA256"):
            audit.audit_release(ui["path"], remote["path"], expected={"ui": "0" * 64})

    def test_host_executable_requires_explicit_path_or_path_discovery(self):
        executable = self.runtime / "Code.exe"
        executable.write_bytes(b"not executed")
        self.assertEqual(host.find_code(executable, {}), executable)
        self.assertEqual(host.find_code(environment={"CODEX_NOTIFIER_VSCODE_EXECUTABLE": str(executable)}), executable)
        with mock.patch.object(host.shutil, "which", return_value=None):
            with self.assertRaisesRegex(ValueError, "provide --code"):
                host.find_code(environment={})
        with self.assertRaises(ValueError):
            host.find_code("relative-executable", {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
