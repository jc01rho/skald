from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
STATE_PATH = ROOT / "k8s" / "hermes" / "deploy_state.py"


def load_state():
    spec = importlib.util.spec_from_file_location("hermes_deploy_state_safety", STATE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    module.MUTATIONS_ALLOWED = True
    module.ACTOR = "test-actor"
    module.IDENTITY_VERIFIED = True
    module.assert_current_identity = lambda: None
    return module


def owner(active="legacy"):
    return {
        "schema_version": 1,
        "namespace": "skald",
        "active_owner": active,
        "generation": 4,
        "legacy_snapshot_ref": "configmap://skald/skald-discord-legacy-0123456789abcdef",
        "hermes_verified_snapshot_ref": "configmap://skald/skald-hermes-verified-fedcba9876543210" if active == "hermes" else None,
        "verified_at": "2026-07-27T00:00:00Z",
        "verified_by": "test",
        "smoke": {"profile": "legacy-mention" if active == "legacy" else "hermes-functional-spec", "correlation_id": "00000000-0000-4000-8000-000000000000", "completed_at": "2026-07-27T00:00:00Z"},
    }


def manifest(name="candidate", data=None):
    return yaml.safe_dump({"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": name, "namespace": "skald"}, "data": data or {"key": "value"}})


def test_get_json_only_treats_not_found_as_missing(monkeypatch):
    state = load_state()
    monkeypatch.setattr(state, "kubectl", lambda *args, **kwargs: SimpleNamespace(returncode=1, stdout=b"", stderr=b'Error from server (NotFound): missing'))
    assert state.get_json("deployment", "missing", allow_missing=True) is None
    monkeypatch.setattr(state, "kubectl", lambda *args, **kwargs: SimpleNamespace(returncode=1, stdout=b"", stderr=b"Forbidden"))
    with pytest.raises(state.Exit) as caught:
        state.get_json("deployment", "forbidden", allow_missing=True)
    assert caught.value.code == 65

def test_readback_accepts_only_omitted_kubernetes_false_terminal_defaults():
    state = load_state()
    intended = {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {"name": "hermes-gateway"},
        "spec": {"template": {"spec": {"containers": [{"name": "hermes-gateway", "stdin": False, "tty": False}]}}},
    }
    observed = {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {"name": "hermes-gateway", "resourceVersion": "1"},
        "spec": {"template": {"spec": {"containers": [{"name": "hermes-gateway"}]}}},
    }
    assert state.intended_fields_match(state.relevant_object(intended), state.relevant_object(observed))

def test_readback_ignores_kubectl_last_applied_annotation_only():
    state = load_state()
    intended = {
        "apiVersion": "v1",
        "kind": "Service",
        "metadata": {"name": "discord-bot-service", "annotations": {"kubectl.kubernetes.io/last-applied-configuration": "old"}},
        "spec": {"type": "ClusterIP"},
    }
    observed = {
        "apiVersion": "v1",
        "kind": "Service",
        "metadata": {"name": "discord-bot-service", "annotations": {"kubectl.kubernetes.io/last-applied-configuration": "new"}},
        "spec": {"type": "ClusterIP", "clusterIP": "10.0.0.1"},
    }
    assert state.intended_fields_match(state.relevant_object(intended), state.relevant_object(observed))
    intended["metadata"]["annotations"]["custom"] = "expected"
    observed["metadata"]["annotations"]["custom"] = "drift"
    assert not state.intended_fields_match(state.relevant_object(intended), state.relevant_object(observed))
def test_wait_rollout_uses_named_get_without_list_or_watch(monkeypatch):
    state = load_state()
    calls = []
    deployment = {
        "metadata": {"generation": 3},
        "spec": {"replicas": 1},
        "status": {"observedGeneration": 3, "updatedReplicas": 1, "readyReplicas": 1, "availableReplicas": 1},
    }
    monkeypatch.setattr(state, "get_json", lambda kind, name: calls.append((kind, name)) or deployment)
    state.wait_rollout("discord-bot")
    assert calls == [("deployment", "discord-bot")]



@pytest.mark.parametrize(
    ("intended_container", "observed_container"),
    [
        ({"name": "hermes-gateway", "stdin": True}, {"name": "hermes-gateway"}),
        ({"name": "hermes-gateway", "tty": True}, {"name": "hermes-gateway"}),
        ({"name": "hermes-gateway", "stdin": False}, {"name": "hermes-gateway", "stdin": True}),
        ({"name": "hermes-gateway", "tty": False}, {"name": "hermes-gateway", "tty": True}),
        ({"name": "hermes-gateway", "readOnly": False}, {"name": "hermes-gateway"}),
    ],
)
def test_readback_rejects_other_omissions_and_terminal_value_drift(intended_container, observed_container):
    state = load_state()
    intended = {"spec": {"template": {"spec": {"containers": [intended_container]}}}}
    observed = {"spec": {"template": {"spec": {"containers": [observed_container]}}}}
    assert not state.intended_fields_match(intended, observed)


def test_function_spec_init_is_restart_idempotent_and_does_not_mask_clone_failure(tmp_path):
    manifest = yaml.safe_load((ROOT / "k8s" / "hermes-gateway-deployment.yaml").read_text())
    init = manifest["spec"]["template"]["spec"]["initContainers"][0]
    script = init["args"][0]
    source = "https://gitlab.git.sparrow.local/mcp-servers/functional-spec.git"
    revision = "c4b6941b4b7bfb054040960099616019a901e745"

    origin = tmp_path / "origin"
    subprocess.run(["git", "init", str(origin)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(origin), "config", "user.email", "test@example.com"], check=True)
    subprocess.run(["git", "-C", str(origin), "config", "user.name", "Test"], check=True)
    (origin / "contract.txt").write_text("expected\n")
    subprocess.run(["git", "-C", str(origin), "add", "contract.txt"], check=True)
    subprocess.run(["git", "-C", str(origin), "commit", "-m", "fixture"], check=True, capture_output=True)
    commit = subprocess.run(
        ["git", "-C", str(origin), "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    ).stdout.strip()

    destination = tmp_path / "sparrow-function-spec"
    destination.mkdir()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for command in ("bun",):
        executable = bin_dir / command
        executable.write_text("#!/bin/sh\nexit 0\n")
        executable.chmod(0o755)
    runnable = script.replace("/opt/sparrow-function-spec", str(destination)).replace(source, str(origin)).replace(revision, commit)
    env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}"}

    for stale_name in ("visible", ".hidden"):
        (destination / stale_name).write_text("stale\n")
    subprocess.run(["/bin/bash", "-ec", runnable], check=True, env=env, capture_output=True)
    assert (destination / "contract.txt").read_text() == "expected\n"
    assert not (destination / ".hidden").exists()

    (destination / ".restart-stale").write_text("stale\n")
    subprocess.run(["/bin/bash", "-ec", runnable], check=True, env=env, capture_output=True)
    assert not (destination / ".restart-stale").exists()
    assert subprocess.run(
        ["git", "-C", str(destination), "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    ).stdout.strip() == commit

    failed = subprocess.run(
        ["/bin/bash", "-ec", runnable.replace(str(origin), str(tmp_path / "missing-origin"))],
        env=env,
        capture_output=True,
    )
    assert failed.returncode != 0

def hermes_snapshot(state):
    deployment = (ROOT / "k8s" / "hermes-gateway-deployment.yaml").read_text().replace("HERMES_IMAGE", "registry.example/hermes@sha256:" + "a" * 64)
    configmap = yaml.safe_dump({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"hermes-gateway-config","namespace":"skald"},"data":{"config.yaml":"x"}})
    data = {"deployment.yaml": deployment, "configmap.yaml": configmap}
    record = {"schema_version":1,"kind":"hermes","namespace":"skald","captured_at":"2026-07-27T00:00:00Z","image":"registry.example/hermes@sha256:" + "a" * 64,"deployment":{"name":"hermes-gateway","data_key":"deployment.yaml","sha256":hashlib.sha256(deployment.encode()).hexdigest(),"replicas":1,"strategy":"Recreate","argv":["hermes","gateway","run"]},"configmap":{"name":"hermes-gateway-config","data_key":"configmap.yaml","sha256":hashlib.sha256(configmap.encode()).hexdigest()},"secret_ref":{"name":"hermes-gateway-secrets","required_keys":["DISCORD_BOT_TOKEN","OPENAI_API_KEY","SKALD_API_KEY","SKALD_PROJECT_ID"]},"smoke_profile":"hermes-functional-spec"}
    digest = state.SNAPSHOT_CODEC.encode_snapshot(
        "hermes", record, {name: payload.encode() for name, payload in data.items()}
    )["snapshot_sha256"]
    record["snapshot_sha256"] = digest
    data["record.json"] = state.canonical(record)
    name = f"skald-hermes-verified-{digest[:16]}"
    return f"configmap://skald/{name}", {"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":name},"immutable":True,"data":data}


def recovery_evidence(record, **overrides):
    evidence = {"schema_version":1,"incident":"INC-1","holder":"dead-holder","actor":"test-actor","request":{"request_id":"REQ-1","requested_at":datetime.now(timezone.utc).isoformat(),"process_quiescence_proof":"pid absent","request_quiescence_proof":"request timed out"},"approver":"security","owner_snapshot":record}
    evidence.update(overrides)
    return evidence


def test_apply_reads_back_single_object_and_accepts_server_metadata(monkeypatch):
    state = load_state()
    calls = []
    monkeypatch.setattr(state, "assert_lease", lambda: {})
    monkeypatch.setattr(state, "kubectl", lambda args, **kwargs: calls.append(args) or SimpleNamespace(returncode=0))
    monkeypatch.setattr(state, "get_json", lambda *_: {"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"candidate","namespace":"skald","resourceVersion":"9","uid":"u"},"data":{"key":"value"}})
    state.apply_bytes(manifest())
    assert calls == [["apply", "-f", "-", "-n", "skald"]]


def test_apply_rejects_multiple_objects_before_mutation(monkeypatch):
    state = load_state()
    mutations = []
    monkeypatch.setattr(state, "assert_lease", lambda: {})
    monkeypatch.setattr(state, "kubectl", lambda *args, **kwargs: mutations.append(args))
    with pytest.raises(state.Exit) as caught:
        state.apply_bytes(manifest() + "---\n" + manifest(name="other"))
    assert caught.value.code == 65
    assert mutations == []


def test_apply_readback_drift_freezes_all_further_mutation(monkeypatch):
    state = load_state()
    monkeypatch.setattr(state, "assert_lease", lambda: {})
    real_kubectl = state.kubectl
    monkeypatch.setattr(state, "kubectl", lambda *args, **kwargs: SimpleNamespace(returncode=0))
    monkeypatch.setattr(state, "get_json", lambda *_: {"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"candidate","namespace":"skald"},"data":{"key":"old"}})
    with pytest.raises(state.Exit) as caught:
        state.apply_bytes(manifest())
    assert caught.value.code == 75
    assert state.MUTATIONS_ALLOWED is False
    monkeypatch.setattr(state, "kubectl", real_kubectl)
    with pytest.raises(state.Exit):
        state.kubectl(["delete", "configmap", "candidate"], mutation=True)


def test_apply_readback_failure_is_recovery_required(monkeypatch):
    state = load_state()
    monkeypatch.setattr(state, "assert_lease", lambda: {})
    monkeypatch.setattr(state, "kubectl", lambda *args, **kwargs: SimpleNamespace(returncode=0))
    monkeypatch.setattr(state, "get_json", lambda *_: (_ for _ in ()).throw(state.Exit(65, "read failed")))
    with pytest.raises(state.Exit) as caught:
        state.apply_bytes(manifest())
    assert caught.value.code == 75
    assert state.MUTATIONS_ALLOWED is False


def test_invalid_utf8_mutation_readback_is_recovery_required(monkeypatch):
    state = load_state()
    responses = iter([
        SimpleNamespace(returncode=0, stdout=b"", stderr=b""),
        SimpleNamespace(returncode=0, stdout=b"\xff", stderr=b""),
    ])
    monkeypatch.setattr(state, "assert_lease", lambda: {})
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: next(responses))
    with pytest.raises(state.Exit) as caught:
        state.apply_bytes(manifest())
    assert caught.value.code == 75
    assert state.MUTATIONS_ALLOWED is False


def test_malformed_json_mutation_readback_is_recovery_required(monkeypatch):
    state = load_state()
    responses = iter([
        SimpleNamespace(returncode=0, stdout=b"", stderr=b""),
        SimpleNamespace(returncode=0, stdout=b"{not-json", stderr=b""),
    ])
    monkeypatch.setattr(state, "assert_lease", lambda: {})
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: next(responses))
    with pytest.raises(state.Exit) as caught:
        state.apply_bytes(manifest())
    assert caught.value.code == 75
    assert state.MUTATIONS_ALLOWED is False


def test_unknown_mutation_response_freezes_zero_further_mutation(monkeypatch):
    state = load_state()
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: (_ for _ in ()).throw(subprocess.TimeoutExpired("kubectl", 1)))
    with pytest.raises(state.Exit) as caught:
        state.kubectl(["apply", "-f", "-"], mutation=True)
    assert caught.value.code == 75
    with pytest.raises(state.Exit):
        state.kubectl(["patch", "deployment", "hermes-gateway"], mutation=True)


def test_release_failure_is_not_swallowed_during_safe_failure(monkeypatch):
    state = load_state()
    monkeypatch.setattr(state, "hermes_configmap_yaml", lambda: "config")
    monkeypatch.setattr(state, "load_owner", lambda required=True: ({}, owner("legacy")))
    monkeypatch.setattr(state, "acquire", lambda: {})
    monkeypatch.setattr(state, "assert_lease", lambda: {})
    monkeypatch.setattr(state, "cutover", lambda *_: (_ for _ in ()).throw(state.Exit(65, "candidate failed")))
    monkeypatch.setattr(state, "release", lambda: (_ for _ in ()).throw(state.Exit(75, "RECOVERY_REQUIRED: release failed")))
    with pytest.raises(state.Exit) as caught:
        state.dispatch("cutover")
    assert caught.value.code == 75


def test_waiting_operator_reloads_owner_after_acquire_and_never_restores_stale_snapshot(monkeypatch):
    state = load_state()
    stale = owner("legacy")
    fresh = owner("legacy")
    fresh["generation"] = stale["generation"] + 1
    fresh["legacy_snapshot_ref"] = "configmap://skald/skald-discord-legacy-1111111111111111"
    acquired = False
    owner_reads = []
    events = []

    def load_owner(required=True):
        owner_reads.append((acquired, required))
        record = fresh if acquired else stale
        events.append(f"owner-read:{record['generation']}")
        return ({"metadata": {"resourceVersion": str(record["generation"])}}, record)

    def acquire():
        nonlocal acquired
        events.append("operator-a-published-generation-5")
        acquired = True
        return {}

    monkeypatch.setattr(state, "load_owner", load_owner)
    monkeypatch.setattr(state, "acquire", acquire)
    monkeypatch.setattr(state, "assert_lease", lambda: events.append("lease-confirmed"))
    monkeypatch.setattr(state, "hermes_configmap_yaml", lambda: "config")
    monkeypatch.setattr(state, "render_hermes", lambda: "deployment")
    monkeypatch.setattr(state, "hermes_preflight", lambda _: "config")
    monkeypatch.setattr(
        state,
        "smoke",
        lambda active: events.append(f"smoke:{active}") or (
            (_ for _ in ()).throw(state.Exit(70, "candidate failed")) if active == "hermes" else {}
        ),
    )
    monkeypatch.setattr(state, "mutate_scale", lambda name, replicas: events.append(f"scale:{name}:{replicas}"))
    monkeypatch.setattr(state, "apply_bytes", lambda payload: events.append(f"apply:{payload}"))
    monkeypatch.setattr(state, "wait_rollout", lambda name: events.append(f"rollout:{name}"))
    monkeypatch.setattr(state, "restore_snapshot", lambda ref, kind: events.append(f"restore:{ref}:{kind}"))

    with pytest.raises(state.Exit) as caught:
        state.dispatch("cutover")

    assert caught.value.code == 75
    assert owner_reads[:2] == [(False, False), (True, False)]
    assert events[:3] == ["owner-read:4", "operator-a-published-generation-5", "lease-confirmed"]
    assert events[3] == "owner-read:5"
    assert events.index("owner-read:5") < events.index("scale:discord-bot:0")
    assert f"restore:{fresh['legacy_snapshot_ref']}:legacy" in events
    assert all(stale["legacy_snapshot_ref"] not in event for event in events)


def test_post_boundary_final_read_failure_retains_lease(monkeypatch):
    state = load_state()
    releases = []
    monkeypatch.setattr(state, "hermes_configmap_yaml", lambda: "config")
    monkeypatch.setattr(state, "load_owner", lambda required=True: ({}, owner("legacy")))
    monkeypatch.setattr(state, "acquire", lambda: {})
    monkeypatch.setattr(state, "assert_lease", lambda: {})
    monkeypatch.setattr(state, "cutover", lambda *_: state.mark_destructive_boundary())
    monkeypatch.setattr(state, "get_json", lambda *_args, **_kwargs: (_ for _ in ()).throw(state.Exit(65, "final read failed")))
    monkeypatch.setattr(state, "release", lambda: releases.append("release"))
    with pytest.raises(state.Exit) as caught:
        state.dispatch("cutover")
    assert caught.value.code == 75
    assert releases == []


def test_post_boundary_restore_failure_retains_lease(monkeypatch):
    state = load_state()
    record = owner("hermes")
    releases = []
    monkeypatch.setattr(state, "load_owner", lambda required=True: ({}, record))
    monkeypatch.setattr(state, "acquire", lambda: {})
    monkeypatch.setattr(state, "assert_lease", lambda: {})
    monkeypatch.setattr(state, "restore_snapshot", lambda *_: (_ for _ in ()).throw(state.Exit(65, "restore failed")))
    monkeypatch.setattr(state, "release", lambda: releases.append("release"))
    with pytest.raises(state.Exit) as caught:
        state.dispatch("rollback")
    assert caught.value.code == 75
    assert releases == []


def test_acquisition_readback_ambiguity_freezes_mutations(monkeypatch):
    state = load_state()
    lease = {"apiVersion":"coordination.k8s.io/v1","kind":"Lease","metadata":{"name":state.LEASE,"namespace":"skald","resourceVersion":"1"},"spec":{"holderIdentity":""}}
    monkeypatch.setattr(state, "get_json", lambda *_: lease)
    monkeypatch.setattr(state, "replace_exact", lambda *args, **kwargs: {**lease, "spec":{"holderIdentity":"other"}})
    with pytest.raises(state.Exit) as caught:
        state.acquire()
    assert caught.value.code == 75
    assert state.MUTATIONS_ALLOWED is False


def test_release_conflict_freezes_mutations(monkeypatch):
    state = load_state()
    lease = {"apiVersion":"coordination.k8s.io/v1","kind":"Lease","metadata":{"name":state.LEASE,"namespace":"skald","resourceVersion":"1"},"spec":{"holderIdentity":"test-actor"}}
    monkeypatch.setattr(state, "assert_lease", lambda: lease)
    monkeypatch.setattr(state, "replace_exact", lambda *args, **kwargs: (_ for _ in ()).throw(state.Conflict()))
    with pytest.raises(state.Exit) as caught:
        state.release()
    assert caught.value.code == 75
    assert state.MUTATIONS_ALLOWED is False


def test_owner_conflict_reconciles_to_current_authority(monkeypatch):
    state = load_state()
    previous = owner("legacy")
    current = owner("legacy")
    current["generation"] = 5
    events = []
    monkeypatch.setattr(state, "assert_lease", lambda: {})
    monkeypatch.setattr(state, "replace_exact", lambda *args, **kwargs: (_ for _ in ()).throw(state.Conflict()))
    monkeypatch.setattr(state, "load_owner", lambda required=True: ({}, current))
    monkeypatch.setattr(state, "restore_snapshot", lambda ref, kind: events.append(("restore", ref, kind)))
    monkeypatch.setattr(state, "smoke", lambda kind: events.append(("smoke", kind)))
    with pytest.raises(state.Exit) as caught:
        state.publish_owner({}, previous, "hermes", "configmap://skald/skald-hermes-verified-fedcba9876543210", {}, "upgrade")
    assert caught.value.code == 73
    assert events == [("restore", current["legacy_snapshot_ref"], "legacy"), ("smoke", "legacy")]


def test_smoke_command_override_is_not_a_production_bypass():
    assert "HERMES_SMOKE_COMMAND" not in STATE_PATH.read_text()


def test_missing_or_example_configmap_fails_before_mutation(monkeypatch, tmp_path):
    state = load_state()
    mutations = []
    monkeypatch.setattr(state, "K8S", tmp_path)
    monkeypatch.delenv("HERMES_CONFIGMAP_FILE", raising=False)
    monkeypatch.setattr(state, "load_owner", lambda required=True: ({}, owner("legacy")))
    monkeypatch.setattr(state, "acquire", lambda: mutations.append("acquire"))

    with pytest.raises(state.Exit) as missing:
        state.dispatch("cutover")
    assert missing.value.code == 65
    assert mutations == []

    example = tmp_path / "hermes-gateway-configmap.yaml.example"
    example.write_text(manifest(name="hermes-gateway-config"))
    monkeypatch.setenv("HERMES_CONFIGMAP_FILE", str(example))
    with pytest.raises(state.Exit) as example_path:
        state.dispatch("cutover")
    assert example_path.value.code == 64
    assert mutations == []


def test_snapshot_requires_non_example_configmap_before_mutation(monkeypatch, tmp_path):
    state = load_state()
    mutations = []
    monkeypatch.setattr(state, "K8S", tmp_path)
    monkeypatch.delenv("HERMES_CONFIGMAP_FILE", raising=False)
    monkeypatch.setattr(state, "assert_lease", lambda: mutations.append("assert_lease"))
    deployment = (ROOT / "k8s" / "hermes-gateway-deployment.yaml").read_text().replace(
        "HERMES_IMAGE", "registry.example/hermes@sha256:" + "a" * 64
    )
    monkeypatch.setenv("HERMES_IMAGE", "registry.example/hermes@sha256:" + "a" * 64)

    with pytest.raises(state.Exit) as caught:
        state.create_hermes_snapshot(deployment)
    assert caught.value.code == 65
    assert mutations == []


def test_secret_key_parser_includes_init_containers():
    state = load_state()
    deployment = yaml.safe_dump({
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {"name": "hermes-gateway"},
        "spec": {"template": {"spec": {
            "initContainers": [{"name": "init", "env": [{"name": "INIT", "valueFrom": {"secretKeyRef": {"name": "secrets", "key": "INIT_SECRET"}}}]}],
            "containers": [{"name": "gateway", "env": [{"name": "MAIN", "valueFrom": {"secretKeyRef": {"name": "secrets", "key": "MAIN_SECRET"}}}]}],
        }}},
    })
    assert state.deployment_secret_keys(deployment, "hermes-gateway") == ("INIT_SECRET", "MAIN_SECRET")


def test_hermes_snapshot_secret_keys_are_structural_and_complete():
    state = load_state()
    rendered = (ROOT / "k8s" / "hermes-gateway-deployment.yaml").read_text().replace("HERMES_IMAGE", "registry.example/hermes@sha256:" + "a" * 64)
    assert state.deployment_secret_keys(rendered, "hermes-gateway") == ("DISCORD_BOT_TOKEN", "OPENAI_API_KEY", "SKALD_API_KEY", "SKALD_PROJECT_ID")


def test_snapshot_rejects_schema_and_artifact_drift(monkeypatch):
    state = load_state()
    ref, obj = hermes_snapshot(state)
    monkeypatch.setattr(state, "get_json", lambda *_: obj)
    state.validate_snapshot(ref, "hermes")
    obj["data"]["deployment.yaml"] += "\n# drift"
    with pytest.raises(state.Exit):
        state.validate_snapshot(ref, "hermes")


def test_recovery_mismatch_evidence_performs_zero_mutation(monkeypatch, tmp_path):
    state = load_state()
    record = owner("legacy")
    mutations = []
    monkeypatch.setattr(state, "get_json", lambda *_: {"spec":{"holderIdentity":"dead-holder"}})
    monkeypatch.setattr(state, "load_owner", lambda required=True: ({}, record))
    monkeypatch.setattr(state, "restore_snapshot", lambda *args: mutations.append(args))
    for index, evidence_data in enumerate((recovery_evidence(record, actor="other"), recovery_evidence({**record, "generation":99}))):
        path = tmp_path / f"evidence-{index}.json"
        path.write_text(json.dumps(evidence_data)); path.chmod(0o600)
        with pytest.raises(state.Exit):
            state.recover(SimpleNamespace(evidence_file=str(path), audit_file=str(tmp_path / "audit.json")))
    assert mutations == []
    assert state.ACTOR == "test-actor"


def test_recovery_adopts_held_lease_for_mutations_and_preserves_authorizing_actor_in_audit(monkeypatch, tmp_path):
    state = load_state()
    record = {**owner("legacy"), "generation": 1}
    held_holder = "SP0021B:968064:009e8ad1-76c7-4a2a-8349-65ef37618187"
    lease = {"apiVersion":"coordination.k8s.io/v1","kind":"Lease","metadata":{"name":state.LEASE,"resourceVersion":"9"},"spec":{"holderIdentity":held_holder}}
    evidence_path = tmp_path / "evidence.json"
    evidence_path.write_text(json.dumps(recovery_evidence(record, holder=held_holder))); evidence_path.chmod(0o600)
    audit_path = tmp_path / "audit.json"
    events = []
    replacements = []

    monkeypatch.setattr(state, "get_json", lambda kind, name, **kwargs: lease if kind == "lease" else None)
    monkeypatch.setattr(state, "load_owner", lambda required=True: ({}, record))

    def restore(ref, kind):
        events.append(("restore", ref, kind, state.ACTOR, state.holder(state.assert_lease())))
        assert state.holder(lease) == held_holder

    def smoke(kind):
        events.append(("smoke", kind, state.ACTOR, state.holder(state.assert_lease())))
        return {"profile":"legacy-mention","correlation_id":"id","completed_at":"now"}

    def replace(desired, **kwargs):
        replacements.append(desired)
        observed = json.loads(json.dumps(desired))
        observed["metadata"]["resourceVersion"] = "10"
        return observed

    monkeypatch.setattr(state, "restore_snapshot", restore)
    monkeypatch.setattr(state, "smoke", smoke)
    monkeypatch.setattr(state, "replace_exact", replace)

    state.recover(SimpleNamespace(evidence_file=str(evidence_path), audit_file=str(audit_path)))

    assert events == [
        ("restore", record["legacy_snapshot_ref"], "legacy", held_holder, held_holder),
        ("smoke", "legacy", held_holder, held_holder),
    ]
    assert state.holder(lease) == held_holder
    assert len(replacements) == 1
    assert state.holder(replacements[0]) == ""
    audit = json.loads(audit_path.read_text())
    assert audit["actor"] == "test-actor"
    assert audit["holder"] == held_holder


def test_recovery_failure_after_holder_handoff_retains_lease(monkeypatch, tmp_path):
    state = load_state()
    record = {**owner("legacy"), "generation": 1}
    held_holder = "SP0021B:968064:009e8ad1-76c7-4a2a-8349-65ef37618187"
    lease = {"spec":{"holderIdentity":held_holder}}
    evidence_path = tmp_path / "evidence.json"
    evidence_path.write_text(json.dumps(recovery_evidence(record, holder=held_holder))); evidence_path.chmod(0o600)
    releases = []

    monkeypatch.setattr(state, "get_json", lambda kind, name, **kwargs: lease if kind == "lease" else None)
    monkeypatch.setattr(state, "load_owner", lambda required=True: ({}, record))
    monkeypatch.setattr(state, "restore_snapshot", lambda *_: (_ for _ in ()).throw(state.Exit(70, "restore failed")))
    monkeypatch.setattr(state, "release", lambda: releases.append(state.ACTOR))

    with pytest.raises(state.Exit) as caught:
        state.recover(SimpleNamespace(evidence_file=str(evidence_path), audit_file=str(tmp_path / "audit.json")))

    assert caught.value.code == 75
    assert "RECOVERY_REQUIRED" in caught.value.message
    assert state.ACTOR == held_holder
    assert state.holder(lease) == held_holder
    assert releases == []
    assert state.MUTATIONS_ALLOWED is False


def test_recovery_stale_evidence_performs_zero_mutation(monkeypatch, tmp_path):
    state = load_state()
    record = owner("legacy")
    evidence_data = recovery_evidence(record)
    evidence_data["request"]["requested_at"] = "2020-01-01T00:00:00Z"
    path = tmp_path / "evidence.json"
    path.write_text(json.dumps(evidence_data)); path.chmod(0o600)
    mutations = []
    monkeypatch.setattr(state, "restore_snapshot", lambda *args: mutations.append(args))
    with pytest.raises(state.Exit):
        state.recover(SimpleNamespace(evidence_file=str(path), audit_file=str(tmp_path / "audit.json")))
    assert mutations == []


def test_recovery_audit_write_failure_prevents_cluster_mutation(monkeypatch, tmp_path):
    state = load_state()
    record = owner("legacy")
    evidence = tmp_path / "evidence.json"
    evidence.write_text(json.dumps(recovery_evidence(record))); evidence.chmod(0o600)
    monkeypatch.setattr(state, "get_json", lambda *_: {"spec":{"holderIdentity":"dead-holder"}})
    monkeypatch.setattr(state, "load_owner", lambda required=True: ({}, record))
    mutations = []
    monkeypatch.setattr(state, "restore_snapshot", lambda *args: mutations.append(args))
    with pytest.raises(state.Exit):
        state.recover(SimpleNamespace(evidence_file=str(evidence), audit_file=str(tmp_path)))
    assert mutations == []


def test_recovery_requires_private_evidence_permissions(tmp_path):
    state = load_state()
    evidence = tmp_path / "evidence.json"
    evidence.write_text("{}")
    evidence.chmod(0o644)
    with pytest.raises(state.Exit) as caught:
        state.recover(SimpleNamespace(evidence_file=str(evidence), audit_file=str(tmp_path / "audit.json")))
    assert caught.value.code == 64
