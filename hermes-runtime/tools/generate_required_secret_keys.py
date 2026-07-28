#!/usr/bin/env python3
"""Derive the required Kubernetes Secret keys from a Deployment manifest.

The generator deliberately reports key names only. It never reads Secret objects,
environment values, or process environment variables.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml


def required_secret_keys(manifest_text: str) -> tuple[str, ...]:
    """Return sorted, unique container env secretKeyRef keys without inspecting values."""
    try:
        documents = list(yaml.safe_load_all(manifest_text))
    except yaml.YAMLError as exc:
        raise ValueError(f"deployment manifest is invalid YAML: {exc}") from exc

    keys: set[str] = set()
    for document in documents:
        if not isinstance(document, dict):
            continue
        pod_spec = (((document.get("spec") or {}).get("template") or {}).get("spec") or {})
        if not isinstance(pod_spec, dict):
            continue
        for field in ("containers", "initContainers"):
            containers = pod_spec.get(field) or []
            if not isinstance(containers, list):
                continue
            for container in containers:
                if not isinstance(container, dict):
                    continue
                env = container.get("env") or []
                if not isinstance(env, list):
                    continue
                for entry in env:
                    if not isinstance(entry, dict):
                        continue
                    value_from = entry.get("valueFrom")
                    if not isinstance(value_from, dict):
                        continue
                    secret_ref = value_from.get("secretKeyRef")
                    if not isinstance(secret_ref, dict):
                        continue
                    key = secret_ref.get("key")
                    if isinstance(key, str) and key:
                        keys.add(key)
    if not keys:
        raise ValueError("deployment contains no container env secretKeyRef entries")
    return tuple(sorted(keys))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "manifest",
        nargs="?",
        default="k8s/hermes-gateway-deployment.yaml",
        help="Deployment manifest to inspect",
    )
    parser.add_argument("--format", choices=("json", "lines"), default="json")
    args = parser.parse_args(argv)

    try:
        keys = required_secret_keys(Path(args.manifest).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"required-secret-key generation failed: {exc}", file=sys.stderr)
        return 1

    if args.format == "lines":
        sys.stdout.write("".join(f"{key}\n" for key in keys))
    else:
        print(json.dumps({"required_secret_keys": list(keys)}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
