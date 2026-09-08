#!/usr/bin/env python3
"""Copy the canonical collector into the UI package, or verify byte equality."""

import argparse
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
FILES = ("src/core.js", "src/extension.js", "scripts/collector.py", "src/i18n.js")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Report stale or missing copies without writing")
    args = parser.parse_args()
    stale = []
    for relative, destination in [(name, "collector/" + name) for name in FILES] + [("src/i18n.js", "lib/i18n.js")]:
        source = ROOT / "remote" / relative
        target = ROOT / "ui" / destination
        content = source.read_bytes()
        if target.is_file() and target.read_bytes() == content:
            continue
        stale.append(relative)
        if not args.check:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
    if args.check and stale:
        print("Local collector copies are stale: " + ", ".join(stale), file=sys.stderr)
        return 1
    print("Local collector copies match all canonical files and shared translations." if args.check
          else "Synchronized {} local collector file(s).".format(len(stale)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
