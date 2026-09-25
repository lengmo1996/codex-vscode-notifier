#!/usr/bin/env python3
"""Build and validate two dependency-free VS Code VSIX packages, fully offline.

The container format follows Microsoft's vscode-vsce package.ts writer:
https://github.com/microsoft/vscode-vsce/blob/main/src/package.ts
This narrow builder supports the two local extensions, not arbitrary npm projects.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "packaging"))
from package_policy import (EXTENSION_FILES, archive_snapshot, collect_reviewed, member_report,
                            read_archive_members)

DEFAULT_OUTPUT = ROOT / "dist"
NS = "http://schemas.microsoft.com/developer/vsx-schema/2011"
CONTENT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
IDS = {"ui": "codex-notifier-ui", "remote": "codex-notifier-collector"}
VERSIONS = {"ui": "0.4.2", "remote": "0.2.5"}
MIMES = {".json": "application/json", ".js": "application/javascript", ".cjs": "application/javascript",
         ".ps1": "text/plain", ".py": "text/plain", ".md": "text/markdown", ".txt": "text/plain",
         ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
         ".ico": "image/x-icon", ".vsixmanifest": "text/xml"}
FIXED_DATE = (2026, 9, 7, 0, 0, 0)
# vsce 3.9.2 normalizes these three documentation names as one reviewed set.
# Source inputs and all other payload paths remain governed by EXTENSION_FILES.
VSCE_DOCUMENT_NAMES = {
    "extension/LICENSE": "extension/LICENSE.txt",
    "extension/CHANGELOG.md": "extension/changelog.md",
    "extension/README.md": "extension/readme.md",
}


def safe_relative(value):
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise ValueError("Package paths must be nonempty POSIX relative paths")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or ":" in path.parts[0]:
        raise ValueError("Package path escapes its extension root: " + value)
    return str(path)


def validate_package(package, variant):
    if not isinstance(package, dict):
        raise ValueError("package.json must be an object")
    expected = IDS[variant]
    if package.get("name") != expected or package.get("publisher") != "lengmo1996":
        raise ValueError("Expected extension ID lengmo1996." + expected)
    if package.get("version") != VERSIONS[variant]:
        raise ValueError("Expected extension version " + VERSIONS[variant])
    if package.get("engines", {}).get("vscode") != "^1.96.0":
        raise ValueError("Expected engines.vscode ^1.96.0")
    if package.get("dependencies") or package.get("optionalDependencies"):
        raise ValueError("Offline builder requires no npm runtime dependencies")
    if package.get("type") == "module":
        raise ValueError("These extensions must use CommonJS")
    if package.get("extensionKind") != (["ui"] if variant == "ui" else ["workspace"]):
        raise ValueError("Unexpected extensionKind for " + variant)
    expected_pack = ["lengmo1996.codex-notifier-collector"] if variant == "ui" else []
    if package.get("extensionPack", []) != expected_pack or package.get("extensionDependencies"):
        raise ValueError("Unexpected extensionPack or cross-host dependencies")
    if safe_relative(package.get("main")) != ("extension.js" if variant == "ui" else "src/extension.js"):
        raise ValueError("Unexpected extension main entry")
    if not isinstance(package.get("displayName"), str) or not package["displayName"]:
        raise ValueError("A displayName is required")
    return package


def collect_files(source, variant):
    return {"extension/" + name: data for name, data in
            collect_reviewed(source, EXTENSION_FILES[variant]).items()}


def child(parent, name, text=None, **attributes):
    result = ET.SubElement(parent, name, attributes)
    if text is not None:
        result.text = str(text)
    return result


def create_manifest(package, file_names):
    root = ET.Element("PackageManifest", {"Version": "2.0.0", "xmlns": NS})
    metadata = child(root, "Metadata")
    child(metadata, "Identity", Language="en-US", Id=package["name"],
          Version=package["version"], Publisher=package["publisher"])
    child(metadata, "DisplayName", package["displayName"])
    description = child(metadata, "Description", package.get("description", ""))
    description.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    child(metadata, "Tags", ",".join(package.get("keywords", [])))
    child(metadata, "Categories", ",".join(package.get("categories", ["Other"])))
    child(metadata, "GalleryFlags", "Public")
    properties = child(metadata, "Properties")
    for key, value in {
        "Microsoft.VisualStudio.Code.Engine": package["engines"]["vscode"],
        "Microsoft.VisualStudio.Code.ExtensionDependencies": ",".join(package.get("extensionDependencies", [])),
        "Microsoft.VisualStudio.Code.ExtensionPack": ",".join(package.get("extensionPack", [])),
        "Microsoft.VisualStudio.Code.ExtensionKind": ",".join(package["extensionKind"]),
        "Microsoft.VisualStudio.Code.ExecutesCode": "true",
        "Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown": "true",
        "Microsoft.VisualStudio.Services.Content.Pricing": "Free",
    }.items():
        child(properties, "Property", Id=key, Value=value)
    for name in file_names:
        if name.lower() in {"extension/license", "extension/license.txt", "extension/license.md"}:
            child(metadata, "License", name)
            break
    if package.get("icon"):
        icon = "extension/" + safe_relative(package["icon"])
        if icon not in file_names:
            raise ValueError("Declared extension icon does not exist")
        child(metadata, "Icon", icon)
    child(child(root, "Installation"), "InstallationTarget", Id="Microsoft.VisualStudio.Code")
    child(root, "Dependencies")
    assets = child(root, "Assets")
    child(assets, "Asset", Type="Microsoft.VisualStudio.Code.Manifest", Path="extension/package.json", Addressable="true")
    for name in sorted(file_names):
        asset_type = None
        if name.lower() == "extension/readme.md":
            asset_type = "Microsoft.VisualStudio.Services.Content.Details"
        elif name.lower() == "extension/changelog.md":
            asset_type = "Microsoft.VisualStudio.Services.Content.Changelog"
        elif name.lower() in {"extension/license", "extension/license.txt", "extension/license.md"}:
            asset_type = "Microsoft.VisualStudio.Services.Content.License"
        if asset_type:
            child(assets, "Asset", Type=asset_type, Path=name, Addressable="true")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def create_content_types(file_names):
    root = ET.Element("Types", {"xmlns": CONTENT_NS})
    suffixes = {PurePosixPath(name).suffix.lower() for name in file_names}
    suffixes.add(".vsixmanifest")
    for suffix in sorted(suffixes):
        if suffix:
            child(root, "Default", Extension=suffix, ContentType=MIMES.get(suffix, "application/octet-stream"))
    # Explicit overrides cover extensionless assets such as LICENSE.
    for name in sorted(file_names):
        if not PurePosixPath(name).suffix:
            child(root, "Override", PartName="/" + name, ContentType="text/plain")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def verify_vsix(path, variant):
    snapshot = archive_snapshot(path)
    with zipfile.ZipFile(io.BytesIO(snapshot)) as archive:
        expected = {"extension.vsixmanifest", "[Content_Types].xml"} | {
            "extension/" + name for name in EXTENSION_FILES[variant]}
        vsce_expected = {VSCE_DOCUMENT_NAMES.get(name, name) for name in expected}
        # Accept either complete naming convention, never a mix or extra alias.
        # The common reader still rejects duplicate/case-colliding members and
        # scans the original member bytes without renaming or skipping content.
        if set(archive.namelist()) == vsce_expected:
            expected = vsce_expected
        files = read_archive_members(archive, expected)
        names = files.keys()
        package = validate_package(json.loads(files["extension/package.json"]), variant)
        if "extension/" + safe_relative(package["main"]) not in names:
            raise ValueError("Extension main entry is missing from VSIX")
        manifest = ET.fromstring(files["extension.vsixmanifest"])
        if manifest.tag != "{" + NS + "}PackageManifest":
            raise ValueError("Invalid VSIX manifest namespace")
        identity = manifest.find("v:Metadata/v:Identity", {"v": NS})
        if identity is None or any(identity.get(k) != package[p] for k, p in
                                   (("Id", "name"), ("Version", "version"), ("Publisher", "publisher"))):
            raise ValueError("VSIX identity differs from package.json")
        engine = manifest.find("v:Metadata/v:Properties/v:Property[@Id='Microsoft.VisualStudio.Code.Engine']", {"v": NS})
        if engine is None or engine.get("Value") != package["engines"]["vscode"]:
            raise ValueError("VSIX engine differs from package.json")
        for key in ("ExtensionPack", "ExtensionDependencies", "ExtensionKind"):
            prop = manifest.find("v:Metadata/v:Properties/v:Property[@Id='Microsoft.VisualStudio.Code." + key + "']", {"v": NS})
            expected_value = ",".join(package.get(key[0].lower() + key[1:], []))
            if prop is None or prop.get("Value") != expected_value:
                raise ValueError("VSIX " + key + " differs from package.json")
        assets = manifest.findall("v:Assets/v:Asset", {"v": NS})
        if not any(a.get("Type") == "Microsoft.VisualStudio.Code.Manifest" and
                   a.get("Path") == "extension/package.json" for a in assets):
            raise ValueError("VSIX package manifest asset is missing")
        if any(a.get("Path") not in names for a in assets):
            raise ValueError("VSIX asset points to an absent file")
        content = ET.fromstring(files["[Content_Types].xml"])
        if content.tag != "{" + CONTENT_NS + "}Types":
            raise ValueError("Invalid content-types namespace")
        return {"extension_id": package["publisher"] + "." + package["name"],
                "version": package["version"], "files": len(names), "bytes": len(snapshot),
                "sha256": hashlib.sha256(snapshot).hexdigest(),
                "members": member_report(files), "allowlist": "reviewed-exact-paths-v1"}


def build_one(source, output_dir, variant):
    source, output_dir = Path(source), Path(output_dir)
    files = collect_files(source, variant)
    if variant == 'ui' and source.resolve() == (ROOT / 'ui').resolve():
        for relative in ('src/core.js', 'src/extension.js', 'scripts/collector.py'):
            copy = source / 'collector' / relative
            if not copy.is_file() or copy.read_bytes() != (ROOT / 'remote' / relative).read_bytes():
                raise ValueError('Run packaging/sync-local-collector.py before packaging: ' + relative)
    package = validate_package(json.loads(files["extension/package.json"].decode("utf-8-sig")), variant)
    if "extension/" + safe_relative(package["main"]) not in files:
        raise ValueError("Extension main entry does not exist")
    files["extension.vsixmanifest"] = create_manifest(package, files)
    files["[Content_Types].xml"] = create_content_types(files)
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / (package["name"] + "-" + package["version"] + ".vsix")
    temporary = destination.with_suffix(".vsix.tmp")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, files[name], compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    result = verify_vsix(temporary, variant)
    temporary.replace(destination)
    result["path"] = str(destination.resolve())
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ui", type=Path, default=ROOT / "ui")
    parser.add_argument("--remote", type=Path, default=ROOT / "remote")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args(argv)
    results = []
    for variant in IDS:
        if args.verify_only:
            path = args.output / (IDS[variant] + "-" + VERSIONS[variant] + ".vsix")
            result = verify_vsix(path, variant)
            result["path"] = str(path.resolve())
        else:
            result = build_one(getattr(args, variant), args.output, variant)
        results.append(result)
    print(json.dumps({"offline": True, "builder": "python-stdlib-vsix", "packages": results}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, ET.ParseError) as error:
        print("Build failed: " + str(error), file=sys.stderr)
        raise SystemExit(1)
