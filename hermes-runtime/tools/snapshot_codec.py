#!/usr/bin/env python3
"""Canonical, byte-preserving snapshot framing for Hermes deploy authority."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

MAGIC = b"SKALD-SNAPSHOT-V1\n"
ENTRY_ORDER = {
    "legacy": ("record.json", "deployment.yaml", "service.yaml", "configmap.yaml"),
    "hermes": ("record.json", "deployment.yaml", "configmap.yaml"),
}


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")


def _entry(name: str, payload: bytes) -> bytes:
    name_bytes = name.encode("utf-8")
    return (
        str(len(name_bytes)).encode("ascii")
        + b":"
        + name_bytes
        + str(len(payload)).encode("ascii")
        + b":"
        + payload
    )


def encode_snapshot(
    kind: str, record: dict[str, Any], artifacts: dict[str, bytes]
) -> dict[str, Any]:
    """Encode a snapshot and return its bytes, hashes, and stored record.

    The framed record omits ``snapshot_sha256`` to avoid self-reference. The
    returned stored record adds the digest produced from that exact frame.
    """
    if kind not in ENTRY_ORDER:
        raise ValueError(f"unsupported snapshot kind: {kind}")
    if not isinstance(record, dict):
        raise TypeError("record must be a mapping")

    expected = ENTRY_ORDER[kind][1:]
    if tuple(artifacts) != expected:
        raise ValueError(
            f"artifacts must be supplied in fixed order {expected!r}; got {tuple(artifacts)!r}"
        )
    if any(not isinstance(payload, bytes) for payload in artifacts.values()):
        raise TypeError("artifact payloads must be bytes")

    aggregate_record = dict(record)
    aggregate_record.pop("snapshot_sha256", None)
    record_payload = canonical_json(aggregate_record)

    frame = bytearray(MAGIC)
    frame.extend(_entry("record.json", record_payload))
    artifact_sha256: dict[str, str] = {}
    for name in expected:
        payload = artifacts[name]
        frame.extend(_entry(name, payload))
        artifact_sha256[name] = hashlib.sha256(payload).hexdigest()

    snapshot_bytes = bytes(frame)
    snapshot_sha256 = hashlib.sha256(snapshot_bytes).hexdigest()
    stored_record = dict(aggregate_record)
    stored_record["snapshot_sha256"] = snapshot_sha256
    return {
        "snapshot": snapshot_bytes,
        "snapshot_sha256": snapshot_sha256,
        "name_suffix": snapshot_sha256[:16],
        "artifact_sha256": artifact_sha256,
        "record": stored_record,
        "record_json": canonical_json(stored_record),
    }


def _parse_artifacts(values: list[str]) -> dict[str, bytes]:
    artifacts: dict[str, bytes] = {}
    for value in values:
        name, separator, path = value.partition("=")
        if not separator or not name or not path:
            raise ValueError("artifact must use NAME=PATH")
        if name in artifacts:
            raise ValueError(f"duplicate artifact: {name}")
        artifacts[name] = Path(path).read_bytes()
    return artifacts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    encode = subparsers.add_parser("encode")
    encode.add_argument("--kind", choices=tuple(ENTRY_ORDER), required=True)
    encode.add_argument("--record", required=True)
    encode.add_argument("--artifact", action="append", default=[])
    encode.add_argument("--output", help="optional path for the raw framed snapshot")
    args = parser.parse_args(argv)

    try:
        record = json.loads(Path(args.record).read_text(encoding="utf-8"))
        result = encode_snapshot(args.kind, record, _parse_artifacts(args.artifact))
        if args.output:
            Path(args.output).write_bytes(result["snapshot"])
    except (OSError, TypeError, ValueError, json.JSONDecodeError) as exc:
        print(f"snapshot encoding failed: {exc}", file=sys.stderr)
        return 1

    output = {
        "artifact_sha256": result["artifact_sha256"],
        "name_suffix": result["name_suffix"],
        "record": result["record"],
        "snapshot_sha256": result["snapshot_sha256"],
    }
    print(canonical_json(output).decode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
