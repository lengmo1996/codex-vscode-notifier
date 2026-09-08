"""Reviewed publication inputs. Changes to these exact lists require source review.

This is a narrow offline release guard, not a general secret detector. No user
settings, credentials, repository history, or runtime directories are inspected.
"""
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import stat


COMMON_FILES = frozenset({"package.json", "README.md", "LICENSE", "CHANGELOG.md", "PRIVACY.md"})
EXTENSION_FILES = {
    "ui": COMMON_FILES | frozenset({
        "extension.js", "lib/i18n.js", "lib/broker-core.js", "lib/broker.js", "lib/client.js",
        "lib/history.js", "lib/navigation.js", "lib/presentation.js", "lib/read-tracking.js", "lib/installation.js",
        "lib/routing.js", "lib/title-pulse.js", "lib/window-attention-native.js",
        "lib/window-attention.js", "lib/window-title.js", "assets/bell.svg",
        "lib/ipc-security.js", "lib/secure-pipe.js", "lib/privacy-storage.js", "lib/privacy.js",
        "assets/secure-pipe.ps1", "assets/secure-pipe.cs",
        "assets/show-notification.ps1", "assets/window-attention.cs", "assets/window-attention.ps1",
        "collector/src/i18n.js", "collector/src/core.js", "collector/src/extension.js", "collector/scripts/collector.py",
    }),
    "remote": COMMON_FILES | frozenset({"src/i18n.js", "src/core.js", "src/extension.js", "scripts/collector.py"}),
}
SOURCE_SUPPORT_FILES = frozenset({
    ".gitignore", "LICENSE", "CONTRIBUTING.md", "SECURITY.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml", ".github/ISSUE_TEMPLATE/feature_request.yml", ".github/ISSUE_TEMPLATE/config.yml",
    "build.py", "README.md", "PRIVACY.md", "packaging/README.md", "packaging/package_policy.py",
    "packaging/bundle-source.py", "packaging/release-audit.py", "packaging/prepare-host-test.py",
    "packaging/run-host-test.py", "packaging/sync-local-collector.py",
    "packaging/native-smoke.js", "packaging/reproduce-url-window-routing.js",
    "tests/i18n.test.js", "tests/package-validation.py", "tests/broker-core.js", "tests/broker-pipe.js",
    "tests/broker-deletion.test.js", "tests/broker-interaction.test.js", "tests/broker-routing.test.js",
    "tests/read-tracking.test.js", "tests/remote-collector.py", "tests/remote-core.js",
    "tests/broker-privacy.test.js", "tests/ui-privacy.test.js", "tests/ui-installation.test.js", "tests/sidebar-navigation.test.js",
    "tests/title-pulse.test.js", "tests/tls-runtime-smoke.js", "tests/ipc-security.test.js", "tests/ui-client-lifecycle.test.js", "tests/ui-client.test.js",
    "tests/ui-history.test.js", "tests/ui-navigation.test.js", "tests/ui-presentation.test.js",
    "tests/window-attention.test.js", "tests/window-title.test.js", "tests/extension-host/index.js",
    "tests/route-editor-fixture/extension.js", "tests/route-editor-fixture/package.json",
})
SOURCE_FILES = SOURCE_SUPPORT_FILES | frozenset(
    f"{variant}/{name}" for variant, names in EXTENSION_FILES.items() for name in names
) | frozenset({"ui/.vscodeignore", "remote/.vscodeignore"})

# Known development outputs are never traversed or copied. Other unexpected
# files/directories fail closed instead of being silently added to a release.
EXCLUDED_DIR_NAMES = frozenset({"__pycache__", ".git", "node_modules"})
EXCLUDED_SOURCE_DIRS = frozenset({
    "dist",
    "packaging/host-runs", "packaging/vsix-install", "packaging/package-test-runs",
    "tests/runtime", "tests/.broker-test-data", "tests/.ipc-test-data",
})
EXCLUDED_EXTENSION_DIRS = frozenset({"tests", "test", "runtime"})
FORBIDDEN_NAMES = frozenset({
    "auth.json", "credentials.json", "credentials", "secrets.json", "settings.json",
    "broker-token", "broker-state.json", "events.jsonl", "hooks.json", "config.toml",
    "id_rsa", "id_ed25519", "id_ecdsa", ".npmrc", ".pypirc", ".git-credentials",
})
FORBIDDEN_SUFFIXES = frozenset({
    ".pem", ".key", ".pfx", ".p12", ".log", ".jsonl", ".sqlite", ".db",
    ".vsix", ".zip", ".tmp", ".bak", ".pyc",
})
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
PRIVATE_KEY = re.compile(rb"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----")
KNOWN_TOKEN = re.compile(rb"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,})")
WINDOWS_ABSOLUTE = re.compile(r"(?i)(?<![A-Za-z0-9])[A-Z]:[\\/]+[^\s\"'<>`]*")
USER_ABSOLUTE = re.compile(r"(?<![A-Za-z0-9])/(?:home|Users|root)/[^\s\"'<>`]*")

# Only these already-reviewed, artificial test literals may resemble developer
# paths. A new path in the same test still fails and needs explicit review.
TEST_PATH_LITERALS = {
    "tests/broker-interaction.test.js": {"C" + r":\\Repo\\Project", "c" + ":" + "\\" * 2},
    "tests/broker-routing.test.js": {"/" + "home/researcher/.codex"},
    "tests/broker-pipe.js": {"/" + "home/user"},
    "tests/broker-core.js": {"/" + "home/user"},
    "tests/ui-client.test.js": {"/" + "home/u/.codex"},
    "tests/ui-presentation.test.js": {"D" + r":\\projects\\rgb2t"},
    "tests/remote-core.js": {"C" + r":\\Users\\研究员", "C" + r":\\Users\\研究员\\.codex"} | {"/" + name for name in (
        "home/user/.codex", "home/research", "home/research/custom",
        "home/research/relative", "home/research/.codex", "home/a/.codex",
        "home/b/.codex", "home/local", "home/local/.codex", "home/local/codex-local",
    )},
}
SYSTEM_PATH_LITERALS = {
    # Built-in Windows system-directory fallback, not an author-machine path.
    name: {"C" + r":\\Windows"} for name in (
        "ui/lib/ipc-security.js", "lib/ipc-security.js", "extension/lib/ipc-security.js")
}


def canonical_member(name):
    if not isinstance(name, str) or not name or "\\" in name or "\x00" in name:
        raise ValueError("Archive members must be nonempty POSIX relative paths")
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or ":" in name or str(path) != name:
        raise ValueError("Noncanonical or escaping archive member: " + name)
    return name


def reject_link(path):
    info = Path(path).lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise ValueError("Symlink/reparse point is not a publication input: " + Path(path).name)
    return info


def reject_link_ancestors(path):
    # Do not resolve first: that would erase evidence of a junction/symlink in
    # an explicitly supplied source or archive path.
    absolute = Path(path).absolute()
    for parent in reversed(absolute.parents):
        reject_link(parent)
    return reject_link(absolute)


def check_filename(name):
    canonical_member(name)
    for part in PurePosixPath(name).parts:
        lower = part.lower()
        if lower.startswith(".env") or lower in FORBIDDEN_NAMES or lower in {".ssh", ".codex"}:
            raise ValueError("Secret/runtime filename is forbidden: " + name)
    if PurePosixPath(name).suffix.lower() in FORBIDDEN_SUFFIXES:
        raise ValueError("Runtime/archive file is forbidden: " + name)


def check_content(name, data, *, source=False):
    if len(data) > MAX_FILE_BYTES:
        raise ValueError("Publication input exceeds size limit: " + name)
    if PRIVATE_KEY.search(data) or KNOWN_TOKEN.search(data):
        raise ValueError("Credential/private-key pattern in publication input: " + name)
    if PurePosixPath(name).suffix.lower() in {".png", ".ico"}:
        return
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValueError("Expected UTF-8 publication input: " + name) from error
    allowed = SYSTEM_PATH_LITERALS.get(name, set()) | (TEST_PATH_LITERALS.get(name, set()) if source else set())
    for pattern in (WINDOWS_ABSOLUTE, USER_ABSOLUTE):
        if any(match.group() not in allowed for match in pattern.finditer(text)):
            # Never repeat the potentially private matched content in reports.
            raise ValueError("Absolute developer path in publication input: " + name)


def collect_reviewed(root, allowed, *, source=False):
    root = Path(root).absolute()
    if not stat.S_ISDIR(reject_link_ancestors(root).st_mode):
        raise ValueError("Publication input root must be a directory")
    allowed = frozenset(canonical_member(name) for name in allowed)
    parents = {str(parent) for name in allowed for parent in PurePosixPath(name).parents if str(parent) != "."}
    found = {}

    def visit(directory):
        with os.scandir(directory) as entries:
            items = sorted(entries, key=lambda item: item.name)
        for entry in items:
            path = Path(entry.path)
            name = path.relative_to(root).as_posix()
            info = reject_link(path)  # Also reject a link used to disguise an excluded directory.
            if stat.S_ISDIR(info.st_mode):
                excluded = (entry.name in EXCLUDED_DIR_NAMES or
                            (source and name in EXCLUDED_SOURCE_DIRS) or
                            (not source and name in EXCLUDED_EXTENSION_DIRS))
                if excluded:
                    continue
                if name not in parents:
                    raise ValueError("Unreviewed source directory: " + name)
                visit(path)
                continue
            if not stat.S_ISREG(info.st_mode):
                raise ValueError("Nonregular publication input: " + name)
            if not source and name == ".vscodeignore":
                continue  # Only the explicit list here controls the offline VSIX.
            check_filename(name)
            if name not in allowed:
                raise ValueError("Unreviewed publication file: " + name)
            data = path.read_bytes()
            check_content(name, data, source=source)
            found[name] = data

    visit(root)
    missing = sorted(allowed - found.keys())
    if missing:
        raise ValueError("Missing reviewed publication input(s): " + ", ".join(missing))
    return found


def member_report(files):
    return [{"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            for name, data in sorted(files.items())]


def archive_snapshot(path):
    info = reject_link_ancestors(path)
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("Archive must be a regular file within the release size limit")
    # Parsing and SHA256 must refer to the same bytes, even if a different
    # process replaces the file after this read. Re-audit immediately pre-upload.
    data = Path(path).read_bytes()
    if len(data) > MAX_ARCHIVE_BYTES:
        raise ValueError("Archive exceeds the release size limit")
    return data


def read_archive_members(archive, expected, *, prefix="", source=False):
    infos = archive.infolist()
    names = [item.filename for item in infos]
    if len(names) != len(set(names)) or len(names) != len({name.casefold() for name in names}):
        raise ValueError("Archive contains duplicate/case-colliding members")
    if set(names) != set(expected):
        raise ValueError("Archive members differ from the reviewed allowlist")
    if sum(item.file_size for item in infos) > MAX_ARCHIVE_BYTES:
        raise ValueError("Archive uncompressed data exceeds size limit")
    files = {}
    for info in infos:
        canonical_member(info.filename)
        mode = info.external_attr >> 16
        if info.is_dir() or stat.S_IFMT(mode) not in {0, stat.S_IFREG} or info.flag_bits & 1:
            raise ValueError("Archive contains a link, nonregular or encrypted member")
        if info.file_size > MAX_FILE_BYTES:
            raise ValueError("Archive member exceeds size limit")
        data = archive.read(info)
        local_name = info.filename[len(prefix):] if prefix else info.filename
        check_filename(local_name)
        check_content(local_name, data, source=source)
        files[info.filename] = data
    return files
