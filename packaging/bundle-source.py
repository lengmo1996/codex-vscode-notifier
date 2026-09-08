#!/usr/bin/env python3
"""Create or audit a deterministic, reviewed source attachment; never upload."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import sys
import zipfile

from package_policy import (SOURCE_FILES, archive_snapshot, collect_reviewed, member_report,
                            read_archive_members)

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "codex-notifier-source/"
FIXED_DATE = (2026, 9, 7, 0, 0, 0)


def verify_source(path):
    snapshot = archive_snapshot(path)
    with zipfile.ZipFile(io.BytesIO(snapshot)) as archive:
        files = read_archive_members(archive, {PREFIX + name for name in SOURCE_FILES},
                                     prefix=PREFIX, source=True)
    return {"archive": Path(path).name, "files": len(files), "bytes": len(snapshot),
            "sha256": hashlib.sha256(snapshot).hexdigest(),
            "members": member_report(files), "allowlist": "reviewed-exact-paths-v1"}


def bundle_source(root, destination):
    files = collect_reviewed(root, SOURCE_FILES, source=True)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(PREFIX + name, date_time=FIXED_DATE)
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    result = verify_source(temporary)
    temporary.replace(destination)
    result["archive"] = destination.name
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args(argv)
    result = verify_source(args.destination) if args.verify_only else bundle_source(args.root, args.destination)
    print(json.dumps({"offline": True, "source": result}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        print("Source audit failed: " + str(error), file=sys.stderr)
        raise SystemExit(1)
