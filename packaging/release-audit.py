#!/usr/bin/env python3
"""Offline pre-publication audit of exact VSIX bytes; never log in or upload.

After reviewing the first report, rerun with --expect-ui-sha256 and
--expect-remote-sha256 to bind the final report to those exact reviewed bytes.
The printed publish argument lists are instructions only. This script never
executes a command or reads a credential store, token environment, or settings.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


build = load_module("notifier_build_audit", ROOT / "build.py")
bundle = load_module("notifier_source_audit", ROOT / "packaging" / "bundle-source.py")


def audit_release(ui, remote, *, source=None, expected=None):
    expected = expected or {}
    reports = []
    for variant, path in (("ui", ui), ("remote", remote)):
        result = build.verify_vsix(path, variant)
        digest = expected.get(variant)
        if digest is not None and (not re.fullmatch(r"[0-9a-fA-F]{64}", digest) or
                                   digest.lower() != result["sha256"]):
            raise ValueError("Reviewed SHA256 does not match the " + variant + " VSIX")
        result["archive"] = Path(path).name
        result["reviewed_sha256_matched"] = digest is not None
        reports.append(result)
    result = {"offline": True, "uploaded": False, "credentials_accessed": False,
              "packages": reports, "all_reviewed_hashes_matched": all(
                  package["reviewed_sha256_matched"] for package in reports),
              "publication_instructions": {
                  "precondition": "Review this report and recheck the same SHA256 immediately before upload.",
                  "argv_templates": [["vsce", "publish", "--packagePath", package["archive"]]
                                     for package in reports],
                  "note": "Run manually from the artifact directory using an already authorized publisher account. "
                          "The --packagePath route uploads the supplied VSIX; do not rebuild or publish a source directory.",
              }}
    if source is not None:
        result["source_attachment"] = bundle.verify_source(source)
        result["source_attachment"]["marketplace_upload"] = False
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ui", required=True, type=Path)
    parser.add_argument("--remote", required=True, type=Path)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--expect-ui-sha256")
    parser.add_argument("--expect-remote-sha256")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args(argv)
    if bool(args.expect_ui_sha256) != bool(args.expect_remote_sha256):
        parser.error("Provide both reviewed VSIX hashes, or omit both for an initial audit")
    expected = {"ui": args.expect_ui_sha256, "remote": args.expect_remote_sha256}
    report = audit_release(args.ui, args.remote, source=args.source, expected=expected)
    text = json.dumps(report, indent=2) + "\n"
    if args.report:
        # An existing review report must not be silently replaced.
        args.report.parent.mkdir(parents=True, exist_ok=True)
        with args.report.open("x", encoding="utf-8") as stream:
            stream.write(text)
    print(text, end="")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, build.zipfile.BadZipFile, build.ET.ParseError) as error:
        print("Release audit failed: " + str(error), file=sys.stderr)
        raise SystemExit(1)
