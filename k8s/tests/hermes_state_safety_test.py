from __future__ import annotations

import hashlib
import importlib.util
import json
import stat
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
    module.AUTHORIZATION_LANE = module.AuthorizationLane.OPERATOR
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


def test_function_spec_http_mcp_does_not_require_init_container():
    manifest = yaml.safe_load((ROOT / "k8s" / "hermes-gateway-deployment.yaml").read_text())
    spec = manifest["spec"]["template"]["spec"]
    assert "initContainers" not in spec
    assert all(
        mount["mountPath"] != "/opt/sparrow-function-spec"
        for container in spec["containers"]
        for mount in container.get("volumeMounts", [])
    )

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


def test_snapshot_prune_plan_keeps_owner_and_newest_retention_window():
    state = load_state()
    record = owner("hermes")
    snapshots = (
        ("skald-hermes-verified-0000000000000000", "2026-07-01T00:00:00Z"),
        ("skald-hermes-verified-1111111111111111", "2026-07-02T00:00:00Z"),
        (record["hermes_verified_snapshot_ref"].rsplit("/", 1)[1], "2026-07-03T00:00:00Z"),
        ("skald-hermes-verified-2222222222222222", "2026-07-04T00:00:00Z"),
        ("skald-hermes-verified-3333333333333333", "2026-07-05T00:00:00Z"),
    )

    assert state.snapshot_prune_plan(record, snapshots, retain=2) == (
        "skald-hermes-verified-0000000000000000",
        "skald-hermes-verified-1111111111111111",
    )


def test_snapshot_prune_plan_rejects_empty_retention_window():
    state = load_state()

    with pytest.raises(state.Exit) as caught:
        state.snapshot_prune_plan(owner("hermes"), (), retain=0)

    assert caught.value.code == 64


def test_snapshot_prune_dry_run_writes_audit_without_deleting(monkeypatch, tmp_path):
    state = load_state()
    state.AUTHORIZATION_LANE = state.AuthorizationLane.SNAPSHOT_PRUNER
    record = owner("hermes")
    snapshots = (
        ("skald-hermes-verified-0000000000000000", "2026-07-01T00:00:00Z"),
        (record["hermes_verified_snapshot_ref"].rsplit("/", 1)[1], "2026-07-02T00:00:00Z"),
        ("skald-hermes-verified-1111111111111111", "2026-07-03T00:00:00Z"),
    )
    events = []
    audit_path = tmp_path / "snapshot-prune.json"
    monkeypatch.setattr(state, "load_owner", lambda required=True: ({}, record))
    monkeypatch.setattr(state, "list_hermes_snapshots", lambda: snapshots)
    monkeypatch.setattr(state, "acquire", lambda: events.append("acquire"))
    monkeypatch.setattr(state, "assert_lease", lambda: events.append("assert"))
    monkeypatch.setattr(state, "delete_hermes_snapshot", lambda name: events.append(("delete", name)))
    monkeypatch.setattr(state, "release", lambda: events.append("release"))

    audit = state.prune_hermes_snapshots(
        SimpleNamespace(retain=1, audit_file=str(audit_path), execute=False)
    )

    assert events == ["acquire", "assert", "release"]
    assert audit["status"] == "dry-run"
    assert audit["candidates"] == ["skald-hermes-verified-0000000000000000"]
    assert json.loads(audit_path.read_text()) == audit
    assert stat.S_IMODE(audit_path.stat().st_mode) == 0o600


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
    monkeypatch.setattr(state, "smoke_evidence", lambda kind: events.append(("smoke", kind)))
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
    monkeypatch.setattr(state, "smoke_evidence", smoke)
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


def test_ordinary_lane_blocks_operator_and_generic_mutation_before_subprocess(monkeypatch):
    state = load_state()
    state.AUTHORIZATION_LANE = state.AuthorizationLane.ORDINARY
    calls = []
    monkeypatch.setattr(state.subprocess, "run", lambda *args, **kwargs: calls.append(args) or SimpleNamespace(returncode=0, stdout=b"", stderr=b""))
    with pytest.raises(state.Exit) as caught:
        state.acquire()
    assert caught.value.code == 77
    with pytest.raises(state.Exit) as caught:
        state.kubectl(["patch", "deployment", "hermes-gateway"], mutation=True)
    assert caught.value.code == 77
    assert calls == []


def test_exact_three_operation_single_image_patch_contract():
    state = load_state()
    image = "ghcr.io/jc01rho/hermes-gateway@sha256:" + "a" * 64
    candidate = "ghcr.io/jc01rho/hermes-gateway@sha256:" + "b" * 64
    deployment = {
        "metadata": {"resourceVersion": "17"},
        "spec": {"template": {"spec": {
            "containers": [{"name": "hermes-gateway", "image": image}],
        }}},
    }
    patch = state.image_patch(deployment, image, candidate)
    assert [item["op"] for item in patch] == ["test", "test", "replace"]
    assert patch[0] == {"op": "test", "path": "/metadata/resourceVersion", "value": "17"}
    assert patch[1]["value"] == image
    assert patch[2]["value"] == candidate
    assert patch[1]["path"] == patch[2]["path"]


@pytest.mark.parametrize("mutation", [
    lambda patch: patch + [{"op": "replace", "path": "/spec/replicas", "value": 1}],
    lambda patch: [{**patch[0], "path": "/status"}, *patch[1:]],
    lambda patch: [{**patch[2], "op": "add"} if index == 2 else item for index, item in enumerate(patch)],
])
def test_image_patch_rejects_extra_op_path_grammar_and_mixed_candidate(mutation):
    state = load_state()
    prior = "ghcr.io/jc01rho/hermes-gateway@sha256:" + "a" * 64
    candidate = "ghcr.io/jc01rho/hermes-gateway@sha256:" + "b" * 64
    base = [
        {"op":"test","path":"/metadata/resourceVersion","value":"1"},
        {"op":"test","path":"/spec/template/spec/containers/0/image","value":prior},
        {"op":"replace","path":"/spec/template/spec/containers/0/image","value":candidate},
    ]
    with pytest.raises(state.Exit) as caught:
        state.validate_image_patch(mutation(base))
    assert caught.value.code == 77


def test_normalization_rejects_missing_duplicate_or_mixed_named_images():
    state = load_state()
    image = "ghcr.io/jc01rho/hermes-gateway@sha256:" + "a" * 64
    base = {"spec":{"template":{"spec":{"containers":[{"name":"hermes-gateway","image":image}]}}}}
    variants = []
    missing = json.loads(json.dumps(base)); missing["spec"]["template"]["spec"]["containers"] = [] ; variants.append(missing)
    duplicate = json.loads(json.dumps(base)); duplicate["spec"]["template"]["spec"]["containers"].append({"name":"hermes-gateway","image":image}); variants.append(duplicate)
    for variant in variants:
        with pytest.raises(state.Exit):
            state.normalized_deployment(variant)


def test_receipt_is_exact_canonical_and_duplicate_keys_fail():
    state = load_state()
    digest = "sha256:" + "a" * 64
    receipt = {
        "schema_version":1,"repository":"jc01rho/skald","workflow_path":".github/workflows/build-hermes-gateway.yml",
        "run_id":7,"run_attempt":2,"run_url":"https://github.com/jc01rho/skald/actions/runs/7/attempts/2",
        "event":"push","ref":"refs/heads/main","head_sha":"b" * 40,"conclusion":"success",
        "image_repository":"ghcr.io/jc01rho/hermes-gateway","digest":digest,
        "subject":"ghcr.io/jc01rho/hermes-gateway@" + digest,
    }
    payload = (state.canonical(receipt) + "\n").encode()
    assert state.validate_receipt_bytes(payload) == receipt
    with pytest.raises(state.Exit):
        state.validate_receipt_bytes(payload.replace(b'"run_id":7', b'"run_id":7,"run_id":7'))
    with pytest.raises(state.Exit):
        state.validate_receipt_bytes(payload.rstrip())


def candidate_fixture(state):
    digest = "sha256:" + "a" * 64
    receipt = {
        "schema_version":1,"repository":"jc01rho/skald","workflow_path":".github/workflows/build-hermes-gateway.yml",
        "run_id":7,"run_attempt":2,"run_url":"https://github.com/jc01rho/skald/actions/runs/7/attempts/2",
        "event":"push","ref":"refs/heads/main","head_sha":"b" * 40,"conclusion":"success",
        "image_repository":"ghcr.io/jc01rho/hermes-gateway","digest":digest,
        "subject":"ghcr.io/jc01rho/hermes-gateway@" + digest,
    }
    run = {
        "id":7,"run_attempt":2,"html_url":"https://github.com/jc01rho/skald/actions/runs/7",
        "event":"push","status":"completed","conclusion":"success","head_branch":"main",
        "head_sha":"b" * 40,"path":".github/workflows/build-hermes-gateway.yml",
        "repository":{"id":1,"full_name":"jc01rho/skald","private":True},
        "created_at":"2026-07-30T00:00:00Z",
    }
    artifact = {
        "id":91,"name":"hermes-gateway-receipt-7-2","size_in_bytes":1024,"expired":False,
        "digest":"sha256:" + "c" * 64,
        "workflow_run":{"id":7,"repository_id":11,"head_repository_id":11,"head_branch":"main","head_sha":"b" * 40},
        "archive_download_url":"https://api.github.com/repos/jc01rho/skald/actions/artifacts/91/zip",
    }
    return receipt, run, artifact


def install_candidate_protocol(monkeypatch, state, tmp_path, *, case="success"):
    receipt, run, artifact = candidate_fixture(state)
    if case == "wrong_ref": receipt["ref"] = "refs/heads/release"
    elif case == "wrong_subject": receipt["subject"] = "ghcr.io/jc01rho/other@" + receipt["digest"]
    elif case == "wrong_digest": receipt["digest"] = "sha256:not-a-digest"
    receipt_bytes = (state.canonical(receipt) + "\n").encode()
    receipt_path = tmp_path / "caller-receipt.json"
    receipt_path.write_bytes(receipt_bytes); receipt_path.chmod(0o600)
    monkeypatch.setenv("HERMES_IMAGE", receipt["subject"])
    monkeypatch.setenv("HERMES_CI_RECEIPT_FILE", str(receipt_path))
    monkeypatch.setenv("GH", "gh")
    commands = []

    def fake_run(command, **kwargs):
        commands.append((command, kwargs.get("cwd")))
        if command == ["gh", "--version"]:
            return SimpleNamespace(returncode=0, stdout=b"gh version 2.97.1 (fixture)\n", stderr=b"")
        if command == ["git", "rev-parse", "HEAD"]:
            head = "d" * 40 if case == "wrong_local_sha" else receipt["head_sha"]
            return SimpleNamespace(returncode=0, stdout=(head + "\n").encode(), stderr=b"")
        if command[-1] == "repos/jc01rho/skald/actions/runs/7":
            observed = json.loads(json.dumps(run))
            mutations = {
                "wrong_run": ("id", 8), "wrong_workflow": ("path", ".github/workflows/other.yml"),
                "wrong_event": ("event", "workflow_dispatch"), "wrong_sha": ("head_sha", "d" * 40),
                "wrong_conclusion": ("conclusion", "failure"), "wrong_status": ("status", "in_progress"),
                "wrong_attempt": ("run_attempt", 3), "wrong_url": ("html_url", "https://github.com/jc01rho/skald/actions/runs/8"),
            }
            if case in mutations:
                key, value = mutations[case]; observed[key] = value
            return SimpleNamespace(returncode=0, stdout=json.dumps(observed).encode(), stderr=b"")
        if command[-1].endswith("/artifacts?name=hermes-gateway-receipt-7-2&per_page=100"):
            observed = json.loads(json.dumps(artifact))
            if case == "artifact_expiry": observed["expired"] = True
            elif case == "artifact_binding_id": observed["workflow_run"]["id"] = 8
            elif case == "artifact_binding_sha": observed["workflow_run"]["head_sha"] = "d" * 40
            entries = [observed, json.loads(json.dumps(observed))] if case == "artifact_duplicates" else [observed]
            return SimpleNamespace(returncode=0, stdout=json.dumps({"total_count":len(entries),"artifacts":entries}).encode(), stderr=b"")
        if command[:3] == ["gh", "run", "download"]:
            directory = Path(command[command.index("--dir") + 1])
            target = directory / "hermes-gateway-receipt.json"
            if case == "artifact_symlink":
                source = tmp_path / "symlink-receipt.json"; source.write_bytes(receipt_bytes); target.symlink_to(source)
            else:
                target.write_bytes(b"{}\n" if case == "artifact_content" else receipt_bytes)
            if case == "artifact_extra_file": (directory / "extra").write_text("unexpected")
            return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")
        pytest.fail(f"unexpected subprocess argv: {command}")

    monkeypatch.setattr(state.subprocess, "run", fake_run)
    observed_digest = "sha256:" + "d" * 64 if case == "ghcr_mismatch" else receipt["digest"]
    monkeypatch.setattr(state, "fetch_ghcr_manifest", lambda _digest: (observed_digest, b'{"schemaVersion":2}'))
    monkeypatch.setattr(state, "kubectl", lambda *_args, **_kwargs: pytest.fail("candidate verification must not invoke kubectl"))
    return receipt, commands


def test_verify_candidate_accepts_official_github_shapes_and_exact_protocol(monkeypatch, tmp_path):
    state = load_state()
    receipt, commands = install_candidate_protocol(monkeypatch, state, tmp_path)
    assert state.verify_candidate() == receipt
    artifact_name = "hermes-gateway-receipt-7-2"
    assert [command for command, _ in commands[:4]] == [
        ["gh", "--version"],
        ["git", "rev-parse", "HEAD"],
        ["gh", "api", "--method", "GET", *state.GH_API_HEADERS, "repos/jc01rho/skald/actions/runs/7"],
        ["gh", "api", "--method", "GET", *state.GH_API_HEADERS, f"repos/jc01rho/skald/actions/runs/7/artifacts?name={artifact_name}&per_page=100"],
    ]
    assert commands[1][1] == state.ROOT
    assert commands[4][0][:8] == ["gh", "run", "download", "7", "--repo", "jc01rho/skald", "--name", artifact_name]
    assert commands[4][0][8] == "--dir"
    assert len(commands) == 5


@pytest.mark.parametrize("case", [
    "wrong_run", "wrong_workflow", "wrong_ref", "wrong_event", "wrong_local_sha", "wrong_sha",
    "wrong_conclusion", "wrong_status", "wrong_attempt", "wrong_url", "wrong_subject", "wrong_digest",
    "artifact_duplicates", "artifact_expiry", "artifact_binding_id", "artifact_binding_sha", "artifact_content", "artifact_extra_file",
    "artifact_symlink", "ghcr_mismatch",
])
def test_verify_candidate_negative_protocol_is_fail_closed(monkeypatch, tmp_path, case):
    state = load_state()
    _, commands = install_candidate_protocol(monkeypatch, state, tmp_path, case=case)
    with pytest.raises(state.Exit) as caught:
        state.verify_candidate()
    assert caught.value.code == 65
    assert all(command[0] != "kubectl" for command, _ in commands)


def test_verify_candidate_cli_emits_canonical_preverified_receipt(monkeypatch, capsys):
    state = load_state()
    receipt = {
        "schema_version":1,"repository":"jc01rho/skald","workflow_path":".github/workflows/build-hermes-gateway.yml",
        "run_id":7,"run_attempt":2,"run_url":"https://github.com/jc01rho/skald/actions/runs/7/attempts/2",
        "event":"push","ref":"refs/heads/main","head_sha":"b" * 40,"conclusion":"success",
        "image_repository":"ghcr.io/jc01rho/hermes-gateway","digest":"sha256:" + "a" * 64,
        "subject":"ghcr.io/jc01rho/hermes-gateway@sha256:" + "a" * 64,
    }
    monkeypatch.setattr(state, "verify_candidate", lambda: receipt)
    monkeypatch.setattr(state, "set_authorization_lane", lambda *_: pytest.fail("standalone verifier must not select a Kubernetes lane"))
    monkeypatch.setattr(state, "verify_operator_identity", lambda: pytest.fail("standalone verifier must not check Kubernetes identity"))
    monkeypatch.setattr(state, "load_owner", lambda **_: pytest.fail("standalone verifier must not read owner state"))
    monkeypatch.setattr(state.sys, "argv", [str(STATE_PATH), "verify-candidate"])
    assert state.main() == 0
    assert capsys.readouterr().out == state.canonical(state.verified_candidate_receipt(receipt)) + "\n"


def test_candidate_dispatch_requires_matching_secure_preverified_receipt_before_kubernetes(monkeypatch, tmp_path):
    state = load_state()
    state.AUTHORIZATION_LANE = state.AuthorizationLane.ORDINARY
    receipt, _, _ = candidate_fixture(state)
    monkeypatch.setenv("HERMES_IMAGE", receipt["subject"])
    monkeypatch.setattr(state, "load_owner", lambda **_: pytest.fail("proof must validate before Kubernetes"))
    with pytest.raises(state.Exit) as missing:
        state.dispatch("")
    assert missing.value.code == 64

    proof = state.verified_candidate_receipt(receipt)
    proof["receipt_sha256"] = "0" * 64
    path = tmp_path / "preverified.json"
    payload = (state.canonical(proof) + "\n").encode()
    path.write_bytes(payload)
    path.chmod(0o600)
    with pytest.raises(state.Exit) as mismatch:
        state.dispatch("", str(path), __import__("hashlib").sha256(payload).hexdigest())
    assert mismatch.value.code == 65


def test_preverified_receipt_local_validation_uses_only_git_and_no_remote_calls(monkeypatch, tmp_path):
    state = load_state()
    receipt, _, _ = candidate_fixture(state)
    monkeypatch.setenv("HERMES_IMAGE", receipt["subject"])
    path = tmp_path / "preverified.json"
    payload = (state.canonical(state.verified_candidate_receipt(receipt)) + "\n").encode()
    path.write_bytes(payload)
    path.chmod(0o600)
    expected = __import__("hashlib").sha256(payload).hexdigest()
    commands = []
    def fake_run(command, **kwargs):
        commands.append(command)
        assert command == ["git", "rev-parse", "HEAD"]
        return SimpleNamespace(returncode=0, stdout=(receipt["head_sha"] + "\n").encode(), stderr=b"")
    monkeypatch.setattr(state.subprocess, "run", fake_run)
    assert state.load_preverified_candidate(str(path), expected) == receipt
    assert commands == [["git", "rev-parse", "HEAD"]]


def test_preverified_envelope_replacement_and_expected_hash_mismatch_fail_before_parse(monkeypatch, tmp_path):
    state = load_state()
    receipt, _, _ = candidate_fixture(state)
    monkeypatch.setenv("HERMES_IMAGE", receipt["subject"])
    original = (state.canonical(state.verified_candidate_receipt(receipt)) + "\n").encode()
    expected = __import__("hashlib").sha256(original).hexdigest()
    path = tmp_path / "preverified.json"
    path.write_bytes(original)
    path.chmod(0o600)
    path.write_bytes(b"{}\n")
    monkeypatch.setattr(state, "parse_json_exact", lambda *_: pytest.fail("hash mismatch must reject before parse"))
    with pytest.raises(state.Exit) as replaced:
        state.load_preverified_candidate(str(path), expected)
    assert replaced.value.code == 65
    with pytest.raises(state.Exit) as wrong_expected:
        state.load_preverified_candidate(str(path), "f" * 64)
    assert wrong_expected.value.code == 65


def test_legacy_ordinary_dispatch_is_zero_write(monkeypatch):
    state = load_state()
    state.AUTHORIZATION_LANE = state.AuthorizationLane.ORDINARY
    monkeypatch.setattr(state, "load_owner", lambda **kwargs: ({"metadata":{"resourceVersion":"1"}}, owner("legacy")))
    monkeypatch.setattr(state, "ordinary_patch", lambda *_: pytest.fail("legacy ordinary must not patch"))
    assert state.ordinary_dispatch(None) == "ordinary-legacy-noop"


def test_candidate_timeout_attempts_one_shot_cas_restore(monkeypatch):
    state = load_state()
    prior = "ghcr.io/jc01rho/hermes-gateway@sha256:" + "a" * 64
    candidate = "ghcr.io/jc01rho/hermes-gateway@sha256:" + "b" * 64
    baseline = {"owner": "o", "lease": "l", "legacy_rv": "1"}
    live = {"metadata": {"resourceVersion": "1"}}
    monkeypatch.setattr(state, "load_owner", lambda required=True: ({}, owner("hermes")))
    monkeypatch.setattr(state, "ordinary_state", lambda *_: (baseline, live, prior))
    monkeypatch.setattr(state, "assert_ordinary_unchanged", lambda _baseline, image: {"metadata": {"resourceVersion": "2" if image == candidate else "3"}})
    monkeypatch.setattr(state, "image_patch", lambda _live, old, new: [{"old": old, "new": new}])
    patches = []
    monkeypatch.setattr(state, "ordinary_patch", lambda patch: patches.append(patch))
    rollouts = []
    def wait(_baseline, image):
        rollouts.append(image)
        if image == candidate:
            raise state.RolloutFailure("candidate rollout timed out")
    monkeypatch.setattr(state, "wait_ordinary_rollout", wait)
    with pytest.raises(state.Exit) as caught:
        state.ordinary_dispatch({"subject": candidate})
    assert caught.value.code == 65
    assert patches == [[{"old": prior, "new": candidate}], [{"old": candidate, "new": prior}]]
    assert rollouts == [candidate, prior]


def test_conclusive_candidate_invariant_drift_attempts_restore(monkeypatch):
    state = load_state()
    prior = "ghcr.io/jc01rho/hermes-gateway@sha256:" + "a" * 64
    candidate = "ghcr.io/jc01rho/hermes-gateway@sha256:" + "b" * 64
    baseline = {"owner": "o", "lease": "l", "legacy_rv": "1"}
    live = {"metadata": {"resourceVersion": "1"}}
    monkeypatch.setattr(state, "load_owner", lambda required=True: ({}, owner("hermes")))
    monkeypatch.setattr(state, "ordinary_state", lambda *_: (baseline, live, prior))
    observations = iter([{"metadata": {"resourceVersion": "1"}}, state.Exit(65, "conclusive status drift"), {"metadata": {"resourceVersion": "2"}}, {"metadata": {"resourceVersion": "3"}}])
    def unchanged(*_):
        value = next(observations)
        if isinstance(value, Exception):
            raise value
        return value
    monkeypatch.setattr(state, "assert_ordinary_unchanged", unchanged)
    monkeypatch.setattr(state, "image_patch", lambda _live, old, new: [{"old": old, "new": new}])
    patches = []
    monkeypatch.setattr(state, "ordinary_patch", lambda patch: patches.append(patch))
    monkeypatch.setattr(state, "wait_ordinary_rollout", lambda *_: None)
    with pytest.raises(state.Exit) as caught:
        state.ordinary_dispatch({"subject": candidate})
    assert caught.value.code == 65
    assert patches == [[{"old": prior, "new": candidate}], [{"old": candidate, "new": prior}]]
