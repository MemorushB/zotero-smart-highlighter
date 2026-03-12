#!/usr/bin/env python3
"""
Package the published neural model runtime asset zip.

The archive root is normalized to the runtime contract expected by the plugin:
    ms-marco-MiniLM-L6-v2.mlpackage/
    vocab.txt
    manifest.json

Usage:
    python scripts/package-model.py \
        --mlpackage /path/to/model.mlpackage \
        --vocab /path/to/vocab.txt \
        --output-dir dist/model-assets
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tempfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


MODEL_ID = "ms-marco-MiniLM-L6-v2"
ASSET_VERSION = "2026.03.10.1"
RELEASE_TAG = "model-ms-marco-minilm-l6-v2-2026.03.10.1"
PACKAGE_DIRECTORY_NAME = "ms-marco-MiniLM-L6-v2.mlpackage"
VOCAB_FILE_NAME = "vocab.txt"
MANIFEST_FILE_NAME = "manifest.json"
ASSET_FILE_NAME = (
    "zotero-smart-highlighter-model-ms-marco-MiniLM-L6-v2-2026.03.10.1.zip"
)
GITHUB_REPO = "MemorushB/zotero-smart-highlighter"
DEFAULT_PLUGIN_MIN_VERSION = "0.2.0"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build the independently published neural model asset zip"
    )
    parser.add_argument(
        "--mlpackage",
        required=True,
        help="Path to the converted .mlpackage directory",
    )
    parser.add_argument(
        "--vocab",
        required=True,
        help="Path to the vocab.txt file",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory that will receive the packaged zip",
    )
    parser.add_argument(
        "--asset-version",
        default=ASSET_VERSION,
        help=f"Asset version embedded in manifest.json (default: {ASSET_VERSION})",
    )
    parser.add_argument(
        "--release-tag",
        default=RELEASE_TAG,
        help=f"GitHub release tag for the published asset (default: {RELEASE_TAG})",
    )
    parser.add_argument(
        "--asset-filename",
        default=ASSET_FILE_NAME,
        help=f"Output zip filename (default: {ASSET_FILE_NAME})",
    )
    parser.add_argument(
        "--plugin-min-version",
        default=DEFAULT_PLUGIN_MIN_VERSION,
        help=(
            "Optional minimum plugin version to record in manifest.json "
            f"(default: {DEFAULT_PLUGIN_MIN_VERSION})"
        ),
    )
    return parser.parse_args()


def copy_tree(source: Path, destination: Path) -> None:
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(source, destination)


def write_manifest(
    destination: Path,
    *,
    asset_version: str,
    release_tag: str,
    asset_filename: str,
    plugin_min_version: str | None,
) -> None:
    manifest = {
        "modelId": MODEL_ID,
        "assetVersion": asset_version,
        "releaseTag": release_tag,
        "assetFileName": asset_filename,
        "packageDirectoryName": PACKAGE_DIRECTORY_NAME,
        "vocabFileName": VOCAB_FILE_NAME,
    }
    if plugin_min_version:
        manifest["pluginMinVersion"] = plugin_min_version

    destination.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def add_directory_to_zip(zip_file: ZipFile, directory: Path, archive_root: str) -> None:
    zip_file.write(directory, archive_root)
    for path in sorted(directory.rglob("*")):
        relative_path = path.relative_to(directory)
        archive_path = f"{archive_root}/{relative_path.as_posix()}"
        if path.is_dir():
            zip_file.write(path, archive_path)
            continue
        zip_file.write(path, archive_path)


def create_zip(source_root: Path, destination_zip: Path) -> None:
    with ZipFile(
        destination_zip, "w", compression=ZIP_DEFLATED, compresslevel=9
    ) as zip_file:
        add_directory_to_zip(
            zip_file,
            source_root / PACKAGE_DIRECTORY_NAME,
            PACKAGE_DIRECTORY_NAME,
        )
        zip_file.write(source_root / VOCAB_FILE_NAME, VOCAB_FILE_NAME)
        zip_file.write(source_root / MANIFEST_FILE_NAME, MANIFEST_FILE_NAME)


def compute_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_inputs(mlpackage_path: Path, vocab_path: Path) -> None:
    if not mlpackage_path.is_dir():
        raise SystemExit(f"Expected .mlpackage directory, got: {mlpackage_path}")
    if mlpackage_path.suffix != ".mlpackage":
        raise SystemExit(f"Input path must end with .mlpackage: {mlpackage_path}")
    if not vocab_path.is_file():
        raise SystemExit(f"Expected vocab.txt file, got: {vocab_path}")


def main() -> int:
    args = parse_args()
    mlpackage_path = Path(args.mlpackage).expanduser().resolve()
    vocab_path = Path(args.vocab).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()

    ensure_inputs(mlpackage_path, vocab_path)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / args.asset_filename

    with tempfile.TemporaryDirectory(prefix="zph-model-package-") as temp_dir:
        staging_root = Path(temp_dir)
        copy_tree(mlpackage_path, staging_root / PACKAGE_DIRECTORY_NAME)
        shutil.copy2(vocab_path, staging_root / VOCAB_FILE_NAME)
        write_manifest(
            staging_root / MANIFEST_FILE_NAME,
            asset_version=args.asset_version,
            release_tag=args.release_tag,
            asset_filename=args.asset_filename,
            plugin_min_version=args.plugin_min_version or None,
        )
        create_zip(staging_root, output_path)

    sha256_hex = compute_sha256(output_path)
    download_path = f"releases/download/{args.release_tag}/{args.asset_filename}"
    download_url = f"https://github.com/{GITHUB_REPO}/{download_path}"

    print(f"output_path={output_path}")
    print(f"asset_filename={args.asset_filename}")
    print(f"sha256={sha256_hex}")
    print(f"release_tag={args.release_tag}")
    print(f"download_path={download_path}")
    print(f"download_url={download_url}")
    print(
        "next_step=Update src/neural-model-installer.ts with this sha256 before shipping the installer."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
