import hashlib
import importlib.util
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).parents[2] / "tools" / "snapshot_codec.py"
SPEC = importlib.util.spec_from_file_location("snapshot_codec", MODULE_PATH)
codec = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(codec)


def test_hermes_fixed_vector_preserves_raw_bytes():
    artifacts = {
        "deployment.yaml": b"apiVersion: v1\nkind: Deployment\n",
        "configmap.yaml": "name: 스칼드\n".encode(),
    }
    result = codec.encode_snapshot(
        "hermes", {"owner": "hermes", "generation": 7}, artifacts
    )

    expected = (
        b"SKALD-SNAPSHOT-V1\n"
        b'11:record.json33:{"generation":7,"owner":"hermes"}'
        b"15:deployment.yaml32:apiVersion: v1\nkind: Deployment\n"
        b"14:configmap.yaml16:name: \xec\x8a\xa4\xec\xb9\xbc\xeb\x93\x9c\n"
    )
    assert result["snapshot"] == expected
    assert result["snapshot_sha256"] == (
        "fa8929d127e547eb5f1928a6502b90bb48bc927625e3c95600c9061595b12fc0"
    )
    assert result["name_suffix"] == "fa8929d127e547eb"
    assert result["artifact_sha256"]["configmap.yaml"] == hashlib.sha256(
        artifacts["configmap.yaml"]
    ).hexdigest()
    assert result["record"]["snapshot_sha256"] == result["snapshot_sha256"]


def test_hash_omits_preexisting_self_reference_and_order_is_strict():
    artifacts = {
        "deployment.yaml": b"d",
        "configmap.yaml": b"c",
    }
    clean = codec.encode_snapshot("hermes", {"owner": "h"}, artifacts)
    stale = codec.encode_snapshot(
        "hermes", {"owner": "h", "snapshot_sha256": "0" * 64}, artifacts
    )
    assert stale["snapshot"] == clean["snapshot"]

    with pytest.raises(ValueError, match="fixed order"):
        codec.encode_snapshot(
            "hermes", {"owner": "h"}, {"configmap.yaml": b"c", "deployment.yaml": b"d"}
        )
