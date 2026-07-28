from __future__ import annotations

import importlib.util
import json
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
DEPLOY_SH = ROOT / "k8s" / "deploy.sh"
STATE_PATH = ROOT / "k8s" / "hermes" / "deploy_state.py"
SMOKE_PATH = ROOT / "k8s" / "hermes" / "smoke.py"


def load_smoke():
    spec = importlib.util.spec_from_file_location("hermes_smoke", SMOKE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


def valid_smoke_profile(owner="hermes"):
    profile = {
        "schema_version": 1,
        "guild_id": "12345678901234567",
        "channel_id": "22345678901234567",
        "operator_user_ids": ["32345678901234567"],
        "owner_bot_user_id": "42345678901234567",
        "probe_template": "probe {correlation_id} owner={owner}",
        "required_response_substrings": ["result {correlation_id}"],
        "forbidden_response_substrings": ["error"],
    }
    if owner == "hermes":
        profile["functional_spec_id"] = "sparrow-function-spec"
        profile["probe_template"] += " spec={functional_spec_id}"
    return profile


def run_invalid_smoke_profile(tmp_path, profile, owner="hermes", extra_args=()):
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(json.dumps(profile))
    command = [
        "python3",
        str(SMOKE_PATH),
        "--owner",
        owner,
        "--token-fd",
        "999999",
        "--profile",
        str(profile_path),
        "--correlation-id",
        "00000000-0000-4000-8000-000000000000",
        "--timeout-seconds",
        "10",
        "--http-timeout-seconds",
        "2",
        "--poll-seconds",
        "1",
        "--result-file",
        str(tmp_path / "result.json"),
        *extra_args,
    ]
    return subprocess.run(command, capture_output=True, text=True)

def load_state():
    spec = importlib.util.spec_from_file_location("hermes_deploy_state", STATE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    module.MUTATIONS_ALLOWED = True
    module.ACTOR = "test-actor"
    module.IDENTITY_VERIFIED = True
    module.assert_current_identity = lambda: None
    return module

def test_operator_identity_preflight_checks_required_and_prohibited_permissions(monkeypatch):
    state = load_state()
    state.IDENTITY_VERIFIED = False
    state.REQUIRED_IDENTITY = "group:hermes-deploy-operators"
    calls = []

    def run(command, **_):
        calls.append(command)
        if command[-4:] == ["auth", "whoami", "-o", "json"]:
            payload = {"status": {"userInfo": {"username": "alice", "groups": ["hermes-deploy-operators"]}}}
            return SimpleNamespace(returncode=0, stdout=json.dumps(payload).encode(), stderr=b"")
        if command[command.index("--request-timeout") + 2 : command.index("--request-timeout") + 5] == ["get", "configmap", state.OWNER_CONFIGMAP]:
            owner_record = {"legacy_snapshot_ref": "configmap://skald/skald-discord-legacy-0123456789abcdef", "hermes_verified_snapshot_ref": None}
            return SimpleNamespace(returncode=0, stdout=json.dumps({"data": {state.OWNER_KEY: json.dumps(owner_record)}}).encode(), stderr=b"")
        permission = (command[command.index("can-i") + 1], command[command.index("can-i") + 2])
        prohibited = {(verb, resource) for verb, resource, _ in state.PROHIBITED_PERMISSIONS}
        return SimpleNamespace(returncode=0, stdout=b"no\n" if permission in prohibited else b"yes\n", stderr=b"")

    monkeypatch.setattr(state.subprocess, "run", run)
    state.verify_operator_identity()
    assert state.IDENTITY_VERIFIED is True
    permission_calls = [call for call in calls if "can-i" in call]
    assert len(permission_calls) == len(state.PROHIBITED_PERMISSIONS) + len(state.OPERATOR_PERMISSIONS) + 1
    assert any("leases.coordination.k8s.io" in call and "--resource-name" in call for call in permission_calls)
    assert any("hermes-gateway" in call for call in permission_calls)
    assert any("discord-bot" in call for call in permission_calls)
    assert any("deletecollection" in call and "secrets" in call for call in permission_calls)
    assert any("delete" in call and "skald-discord-legacy-0123456789abcdef" in call for call in permission_calls)
    assert any("impersonate" in call and "serviceaccounts" in call for call in permission_calls)


def test_operator_identity_with_required_plus_prohibited_grant_fails_before_mutation(monkeypatch):
    state = load_state()
    state.IDENTITY_VERIFIED = False
    state.REQUIRED_IDENTITY = "user:alice"
    whoami = {"status": {"userInfo": {"username": "alice", "groups": []}}}
    monkeypatch.setattr(state, "read_current_identity", lambda _: whoami)
    prohibited_grant = ("deletecollection", "secrets")

    def run(command, **_):
        assert command[command.index("auth") + 1] == "can-i"
        permission = (command[command.index("can-i") + 1], command[command.index("can-i") + 2])
        allowed = permission == prohibited_grant or permission not in {
            (verb, resource) for verb, resource, _ in state.PROHIBITED_PERMISSIONS
        }
        return SimpleNamespace(returncode=0, stdout=b"yes\n" if allowed else b"no\n", stderr=b"")

    def current_snapshot_names(_):
        return ()

    monkeypatch.setattr(state, "current_snapshot_names", current_snapshot_names)

    monkeypatch.setattr(state.subprocess, "run", run)
    mutated = []
    monkeypatch.setattr(state, "dispatch", lambda _: mutated.append("dispatch"))
    monkeypatch.setattr(state.argparse.ArgumentParser, "parse_args", lambda _: SimpleNamespace(command="dispatch", mode="cutover"))
    with pytest.raises(state.Exit) as caught:
        state.main()
    assert caught.value.code == 77
    assert "prohibited permission" in caught.value.message
    assert mutated == []


def test_operator_identity_preflight_rejects_wildcard_and_command_path_rechecks_identity(monkeypatch):
    state = load_state()
    state.IDENTITY_VERIFIED = False
    state.REQUIRED_IDENTITY = "user:alice"
    whoami = {"status": {"userInfo": {"username": "alice", "groups": []}}}
    monkeypatch.setattr(state, "read_current_identity", lambda _: whoami)
    monkeypatch.setattr(state.subprocess, "run", lambda *_, **__: SimpleNamespace(returncode=0, stdout=b"yes\n", stderr=b""))
    with pytest.raises(state.Exit) as caught:
        state.verify_operator_identity()
    assert caught.value.code == 77

    state.IDENTITY_VERIFIED = True
    state.assert_current_identity = lambda: (_ for _ in ()).throw(state.Exit(77, "changed"))
    with pytest.raises(state.Exit) as bypass:
        state.kubectl(["get", "lease", state.LEASE])
    assert bypass.value.code == 77


def test_deploy_script_passes_required_identity_and_rbac_has_no_decorative_serviceaccount():
    text = DEPLOY_SH.read_text()
    dispatch = text[text.index("deploy_discord_owner()") : text.index("deploy_discord_bot()")]
    assert 'HERMES_DEPLOY_IDENTITY="$HERMES_DEPLOY_IDENTITY"' in dispatch
    rbac = yaml.safe_load_all((ROOT / "k8s" / "hermes-deploy-operator-rbac.yaml").read_text())
    objects = list(rbac)
    assert {obj["kind"] for obj in objects} == {"Role", "RoleBinding"}
    binding = next(obj for obj in objects if obj["kind"] == "RoleBinding")
    assert binding["subjects"] == [{"kind": "Group", "name": "hermes-deploy-operators", "apiGroup": "rbac.authorization.k8s.io"}]
    role = next(obj for obj in objects if obj["kind"] == "Role")
    grants = {
        (tuple(rule["apiGroups"]), tuple(rule["resources"]), tuple(rule.get("resourceNames", [])), tuple(rule["verbs"]))
        for rule in role["rules"]
    }
    assert (("coordination.k8s.io",), ("leases",), ("skald-discord-deploy-operation",), ("get", "update")) in grants
    lease_rule = next(rule for rule in role["rules"] if rule["resources"] == ["leases"])
    assert "patch" not in lease_rule["verbs"]
    assert "create" not in lease_rule["verbs"]
    assert "delete" not in lease_rule["verbs"]
    deployment_rules = [rule for rule in role["rules"] if rule["resources"] == ["deployments"]]
    assert any("patch" in rule["verbs"] for rule in deployment_rules)
    assert all("delete" not in rule["verbs"] and "deletecollection" not in rule["verbs"] for rule in role["rules"])


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


def test_exact_dispatch_unset_uses_durable_owner_only(monkeypatch):
    state = load_state()
    monkeypatch.setattr(state, "load_owner", lambda required=True: ({}, owner("legacy")))
    assert state.dispatch("") == "legacy"
    monkeypatch.setattr(state, "load_owner", lambda required=True: ({}, owner("hermes")))
    assert state.dispatch("") == "skip"


def test_unknown_mode_rejects_before_cluster_read(monkeypatch):
    state = load_state()
    monkeypatch.setattr(state, "load_owner", lambda **_: pytest.fail("must not read owner"))
    with pytest.raises(state.Exit) as caught:
        state.dispatch("deploy")
    assert caught.value.code == 64


def test_ordinary_deploy_cannot_start_legacy_when_owner_is_hermes():
    text = DEPLOY_SH.read_text()
    callsite = text[text.index("deploy_discord_owner()") : text.index("deploy_discord_bot()")]
    assert 'skip)' in callsite
    assert "deploy_discord_bot" not in callsite[callsite.index("skip)") : callsite.index("managed)")]
    main = text[text.index("main()") :]
    assert "deploy_discord_owner" in main
    assert "        deploy_discord_bot\n" not in main


def test_hermes_image_is_full_separate_immutable_input():
    text = DEPLOY_SH.read_text()
    assert 'HERMES_IMAGE="${HERMES_IMAGE:-}"' in text
    assert "HERMES_IMAGE:-$IMAGE_TAG" not in text
    state = load_state()
    with pytest.raises(state.Exit):
        state.render_hermes()
    os.environ["HERMES_IMAGE"] = "registry.example/hermes@sha256:" + "a" * 64
    state.HERMES_IMAGE = os.environ["HERMES_IMAGE"]
    try:
        rendered = state.render_hermes()
        assert os.environ["HERMES_IMAGE"] in rendered
    finally:
        os.environ.pop("HERMES_IMAGE")


def test_snapshot_codec_contract_fixed_vector():
    state = load_state()
    result = state.SNAPSHOT_CODEC.encode_snapshot(
        "hermes",
        {},
        {"deployment.yaml": b"x", "configmap.yaml": b""},
    )
    expected = (
        b"SKALD-SNAPSHOT-V1\n"
        b"11:record.json2:{}"
        b"15:deployment.yaml1:x"
        b"14:configmap.yaml0:"
    )
    assert result["snapshot"] == expected
    assert result["snapshot_sha256"] == "0f7a04e068d09f618fe4f0c58fff137e8d655a1fcdc772d0f894d5be6d111182"
    assert state.SNAPSHOT_CODEC_PATH == ROOT / "hermes-runtime" / "tools" / "snapshot_codec.py"


def test_second_operator_with_nonempty_holder_performs_zero_mutation(monkeypatch):
    state = load_state()
    commands = []
    monkeypatch.setattr(state, "get_json", lambda *args, **kwargs: {"metadata": {"resourceVersion": "opaque-rv"}, "spec": {"holderIdentity": "operator-a"}})
    monkeypatch.setattr(state, "replace_exact", lambda *args, **kwargs: commands.append(args))
    with pytest.raises(state.Exit) as caught:
        state.acquire()
    assert caught.value.code == 73
    assert commands == []


def test_opaque_resource_version_is_only_exact_cas(monkeypatch):
    state = load_state()
    sent = {}
    monkeypatch.setattr(state, "kubectl", lambda args, **kwargs: sent.update(args=args, body=json.loads(kwargs["stdin"])) or SimpleNamespace())
    obj = {"apiVersion": "coordination.k8s.io/v1", "kind": "Lease", "metadata": {"name": state.LEASE, "namespace": "skald", "resourceVersion": "not-numeric/opaque"}, "spec": {"holderIdentity": "test-actor"}}
    monkeypatch.setattr(state, "get_json", lambda *_: obj)
    state.replace_exact(obj, expected_kind="lease", expected_name=state.LEASE)
    assert sent["args"] == ["replace", "-f", "-"]
    assert sent["body"]["metadata"]["resourceVersion"] == "not-numeric/opaque"


def test_unknown_mutation_response_enters_recovery_and_freezes(monkeypatch):
    state = load_state()
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: (_ for _ in ()).throw(subprocess.TimeoutExpired("kubectl", 1)))
    with pytest.raises(state.Exit) as caught:
        state.kubectl(["patch", "deployment", "discord-bot"], mutation=True)
    assert caught.value.code == 75
    assert "RECOVERY_REQUIRED" in caught.value.message
    with pytest.raises(state.Exit) as frozen:
        state.kubectl(["patch", "deployment", "hermes-gateway"], mutation=True)
    assert frozen.value.code == 75


def test_automatic_cutover_rollback_is_ordered(monkeypatch):
    state = load_state()
    events = []
    record = owner("legacy")
    monkeypatch.setattr(state, "render_hermes", lambda: "deployment")
    monkeypatch.setattr(state, "hermes_preflight", lambda _: "config")
    monkeypatch.setattr(state, "smoke", lambda value: events.append(f"smoke:{value}") or ({"profile": value, "correlation_id": "id", "completed_at": "now"} if value == "legacy" else (_ for _ in ()).throw(state.Exit(70, "candidate failed"))))
    monkeypatch.setattr(state, "mutate_scale", lambda name, replicas: events.append(f"scale:{name}:{replicas}"))
    monkeypatch.setattr(state, "apply_bytes", lambda _: events.append("apply:hermes"))
    monkeypatch.setattr(state, "wait_rollout", lambda _: events.append("rollout:hermes"))
    monkeypatch.setattr(state, "restore_snapshot", lambda ref, kind: events.append(f"restore:{kind}"))
    with pytest.raises(state.Exit):
        state.cutover({}, record)
    assert events == ["smoke:legacy", "scale:discord-bot:0", "apply:hermes", "apply:hermes", "rollout:hermes", "smoke:hermes", "restore:legacy", "smoke:legacy"]


def test_unknown_post_stop_failure_does_not_attempt_rollback(monkeypatch):
    state = load_state()
    events = []
    monkeypatch.setattr(state, "render_hermes", lambda: "deployment")
    monkeypatch.setattr(state, "hermes_preflight", lambda _: "config")
    monkeypatch.setattr(state, "smoke", lambda owner: events.append(f"smoke:{owner}") or {})
    monkeypatch.setattr(state, "mutate_scale", lambda *_: (_ for _ in ()).throw(state.Exit(75, "RECOVERY_REQUIRED")))
    monkeypatch.setattr(state, "restore_snapshot", lambda *_: events.append("restore"))
    with pytest.raises(state.Exit) as caught:
        state.cutover({}, owner("legacy"))
    assert caught.value.code == 75
    assert "restore" not in events


def test_retained_undeploy_stops_before_cleanup_when_state_transition_fails():
    text = DEPLOY_SH.read_text()
    retained = text[text.index("undeploy_retained()") : text.index("\n}\n\nundeploy()") + 2]
    script = "\n".join(
        (
            "NAMESPACE=skald",
            "python3() { return 23; }",
            "log_info() { :; }",
            "log_error() { :; }",
            "log_warning() { :; }",
            "log_success() { :; }",
            "undeploy_traefik() { echo CLEANUP_ATTEMPTED; }",
            "undeploy_ingress() { echo CLEANUP_ATTEMPTED; }",
            "undeploy_ui() { echo CLEANUP_ATTEMPTED; }",
            "undeploy_ai_services() { echo CLEANUP_ATTEMPTED; }",
            "undeploy_worker() { echo CLEANUP_ATTEMPTED; }",
            "undeploy_backend() { echo CLEANUP_ATTEMPTED; }",
            "undeploy_rabbitmq() { echo CLEANUP_ATTEMPTED; }",
            "undeploy_redis() { echo CLEANUP_ATTEMPTED; }",
            "undeploy_postgres() { echo CLEANUP_ATTEMPTED; }",
            "undeploy_pvcs() { echo CLEANUP_ATTEMPTED; }",
            "undeploy_non_discord_configs() { echo CLEANUP_ATTEMPTED; }",
            retained,
            "undeploy_retained",
        )
    )
    completed = subprocess.run(["bash", "-c", script], capture_output=True, text=True)
    assert completed.returncode == 23
    assert "CLEANUP_ATTEMPTED" not in completed.stdout


def test_retained_undeploy_has_explicit_non_discord_cleanup_allowlist():
    text = DEPLOY_SH.read_text()
    retained = text[text.index("undeploy_retained()") : text.index("undeploy()")]
    expected_calls = {
        "undeploy_traefik",
        "undeploy_ingress",
        "undeploy_ui",
        "undeploy_ai_services",
        "undeploy_worker",
        "undeploy_backend",
        "undeploy_rabbitmq",
        "undeploy_redis",
        "undeploy_postgres",
        "undeploy_pvcs",
        "undeploy_non_discord_configs",
    }
    actual_calls = {
        line.strip().split()[0]
        for line in retained.splitlines()
        if line.strip().startswith("undeploy_") and not line.strip().startswith("undeploy_retained")
    }
    assert actual_calls == expected_calls
    assert "undeploy_configs" not in text
    assert "python3 hermes/deploy_state.py retained-undeploy" in retained


def test_retained_cleanup_cannot_delete_discord_authority_or_use_broad_deletion():
    text = DEPLOY_SH.read_text()
    retained = text[text.index("undeploy_retained()") : text.index("undeploy()")]
    helper_names = {
        line.strip().split()[0]
        for line in retained.splitlines()
        if line.strip().startswith("undeploy_") and not line.strip().startswith("undeploy_retained")
    }
    helper_bodies = []
    for name in helper_names:
        start = text.index(f"{name}()")
        helper_bodies.append(text[start : text.index("\n}\n", start) + 2])
    cleanup = "\n".join((retained, *helper_bodies))
    delete_lines = "\n".join(line.strip() for line in cleanup.splitlines() if "kubectl delete" in line)

    prohibited_broad_deletion = (
        " --all",
        "api-resources",
        "delete namespace",
        "remaining_pods",
        "remaining_deployments",
        "delete pod",
        "delete replicasets",
        "delete deployments,",
        "kubectl delete $",
        'kubectl delete "$' + "{",
    )
    for token in prohibited_broad_deletion:
        assert token not in cleanup

    retained_resources = (
        "discord-bot",
        "discord-bot-service",
        "discord-bot-config",
        "discord-bot-secrets",
        "hermes-gateway",
        "hermes-gateway-service",
        "hermes-gateway-config",
        "hermes-gateway-secrets",
        "skald-discord-owner-state",
        "skald-discord-legacy-",
        "skald-hermes-verified-",
        "skald-discord-deploy-operation",
        "hermes-deploy-operator",
    )
    for resource in retained_resources:
        assert resource not in delete_lines
    assert "delete namespace" not in delete_lines
    assert "undeploy_namespace" not in retained


def test_unreachable_destructive_undeploy_branch_is_removed():
    text = DEPLOY_SH.read_text()
    undeploy_body = text[text.index("undeploy()") : text.index("\n}\n\n# 메인 함수") + 2]
    assert undeploy_body.count("undeploy_retained") == 1
    assert "return\n" not in undeploy_body
    assert "remaining_pods" not in undeploy_body
    assert "api-resources" not in undeploy_body


def test_recovery_is_explicit_and_proof_gated(tmp_path):
    state = load_state()
    evidence = tmp_path / "evidence.json"
    evidence.write_text("{}")
    evidence.chmod(0o600)
    args = SimpleNamespace(evidence_file=str(evidence), audit_file=str(tmp_path / "audit.json"))
    with pytest.raises(state.Exit) as caught:
        state.recover(args)
    assert caught.value.code == 65


def test_smoke_cli_is_fd_only_correlated_and_redacted():
    text = SMOKE_PATH.read_text()
    assert 'parser.add_argument("--token-fd"' in text
    assert "--token" not in text.replace("--token-fd", "")
    assert "Authorization" in text
    assert "response.read()" in text
    assert "print(content" not in text
    assert '"correlation_id"' in text
    assert "required_response_substrings" in text
    assert "forbidden_response_substrings" in text


def run_smoke(monkeypatch, tmp_path, fake_request, capsys, *, timeout="10"):
    smoke = load_smoke()
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(json.dumps(valid_smoke_profile()))
    result_path = tmp_path / "result.json"
    correlation = "00000000-0000-4000-8000-000000000000"
    read_fd, write_fd = os.pipe()
    os.write(write_fd, b"secret-token")
    os.close(write_fd)
    monkeypatch.setattr(smoke, "request_json", fake_request)
    monkeypatch.setattr(smoke.time, "sleep", lambda _: None)
    monkeypatch.setattr(smoke.sys, "argv", ["smoke.py", "--owner", "hermes", "--token-fd", str(read_fd), "--profile", str(profile_path), "--correlation-id", correlation, "--timeout-seconds", timeout, "--http-timeout-seconds", "2", "--poll-seconds", "1", "--result-file", str(result_path)])
    try:
        return smoke.main(), result_path, capsys.readouterr()
    finally:
        os.close(read_fd)


def test_smoke_surfaces_probe_and_accepts_parent_channel_owner_reply(monkeypatch, tmp_path, capsys):
    correlation = "00000000-0000-4000-8000-000000000000"
    probe = {"id": "probe-id", "channel_id": "22345678901234567", "author": {"id": "32345678901234567"}, "content": f"probe {correlation} owner=hermes spec=sparrow-function-spec"}
    requests = []

    def fake_request(token, url, timeout, *, method="GET", body=None, allow_not_found=False):
        requests.append((token, url, method, body))
        assert method == "GET"
        if url.endswith("/channels/probe-id/messages?limit=100"):
            return []
        if len([request for request in requests if "22345678901234567" in request[1]]) == 1:
            return [probe]
        return [probe, {"id": "answer", "channel_id": "22345678901234567", "author": {"id": "42345678901234567"}, "message_reference": {"message_id": "probe-id"}, "content": f"result {correlation}"}]

    status, result_path, captured = run_smoke(monkeypatch, tmp_path, fake_request, capsys)
    assert status == 0
    assert captured.err.splitlines()[0] == f"probe {correlation} owner=hermes spec=sparrow-function-spec"
    assert "secret-token" not in captured.out + captured.err
    assert all(request[2] == "GET" and request[3] is None for request in requests)
    result = json.loads(result_path.read_text())
    assert result["probe_message_id"] == "probe-id"
    assert result["response_message_ids"] == ["answer"]


def test_smoke_accepts_auto_thread_owner_reply(monkeypatch, tmp_path, capsys):
    correlation = "00000000-0000-4000-8000-000000000000"
    probe = {"id": "probe-id", "channel_id": "22345678901234567", "author": {"id": "32345678901234567"}, "content": f"probe {correlation} owner=hermes spec=sparrow-function-spec"}

    def fake_request(token, url, timeout, *, method="GET", body=None, allow_not_found=False):
        if url.endswith("/channels/probe-id/messages?limit=100"):
            return [{"id": "thread-answer", "channel_id": "probe-id", "author": {"id": "42345678901234567"}, "content": f"result {correlation}"}]
        return [probe]

    status, result_path, _ = run_smoke(monkeypatch, tmp_path, fake_request, capsys)
    assert status == 0
    assert json.loads(result_path.read_text())["response_message_ids"] == ["thread-answer"]


def test_smoke_times_out_waiting_for_configured_operator_without_leaking_token(monkeypatch, tmp_path, capsys):
    times = iter((0, 0, 11))
    smoke = load_smoke()
    monkeypatch.setattr(smoke.time, "time", lambda: next(times))
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(json.dumps(valid_smoke_profile()))
    result_path = tmp_path / "result.json"
    read_fd, write_fd = os.pipe()
    os.write(write_fd, b"secret-token")
    os.close(write_fd)
    monkeypatch.setattr(smoke, "request_json", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(smoke.time, "sleep", lambda _: None)
    monkeypatch.setattr(smoke.sys, "argv", ["smoke.py", "--owner", "hermes", "--token-fd", str(read_fd), "--profile", str(profile_path), "--correlation-id", "00000000-0000-4000-8000-000000000000", "--timeout-seconds", "10", "--http-timeout-seconds", "2", "--poll-seconds", "1", "--result-file", str(result_path)])
    try:
        with pytest.raises(SystemExit) as caught:
            smoke.main()
    finally:
        os.close(read_fd)
    captured = capsys.readouterr()
    assert caught.value.code == 67
    assert "category=operator_probe_timeout" in captured.err
    assert "secret-token" not in captured.out + captured.err


def test_deploy_state_streams_smoke_subprocess_output():
    smoke_body = STATE_PATH.read_text()[STATE_PATH.read_text().index("def smoke(owner:") : STATE_PATH.read_text().index("def publish_owner(")]
    assert "stdout=subprocess.PIPE" not in smoke_body
    assert "stderr=subprocess.PIPE" not in smoke_body

@pytest.mark.parametrize(
    "mutate",
    [
        lambda profile: profile.update(extra=True),
        lambda profile: profile.update(schema_version="1"),
        lambda profile: profile.update(guild_id="123"),
        lambda profile: profile.update(operator_user_ids=[]),
        lambda profile: profile.update(operator_user_ids=["32345678901234567", "32345678901234567"]),
        lambda profile: profile.update(probe_template="probe {correlation_id}"),
        lambda profile: profile.update(required_response_substrings=[]),
        lambda profile: profile.update(required_response_substrings=["uncorrelated"]),
        lambda profile: profile.update(forbidden_response_substrings=[]),
        lambda profile: profile.update(functional_spec_id=""),
        lambda profile: profile.update(forbidden_response_substrings=["   "]),
    ],
)
def test_invalid_smoke_profiles_fail_before_credential_access(tmp_path, mutate):
    profile = valid_smoke_profile()
    mutate(profile)
    completed = run_invalid_smoke_profile(tmp_path, profile)
    assert completed.returncode == 64
    assert "category=profile_schema" in completed.stderr
    assert "missing_credential" not in completed.stderr


@pytest.mark.parametrize(
    "extra_args",
    [
        ("--timeout-seconds", "0"),
        ("--http-timeout-seconds", "0"),
        ("--poll-seconds", "0"),
        ("--poll-seconds", "10"),
        ("--poll-seconds", "nan"),
    ],
)
def test_invalid_smoke_bounds_fail_before_credential_access(tmp_path, extra_args):
    completed = run_invalid_smoke_profile(tmp_path, valid_smoke_profile(), extra_args=extra_args)
    assert completed.returncode == 64
    assert "category=cli_or_profile" in completed.stderr
    assert "missing_credential" not in completed.stderr


def test_legacy_smoke_profile_rejects_hermes_only_key(tmp_path):
    profile = valid_smoke_profile("legacy")
    profile["functional_spec_id"] = "unexpected"
    completed = run_invalid_smoke_profile(tmp_path, profile, owner="legacy")
    assert completed.returncode == 64
    assert "category=profile_schema" in completed.stderr


def test_hermes_readme_documents_exact_mount_and_secret_contract():
    readme = (ROOT / "k8s" / "README.md").read_text()
    assert "`/var/lib/hermes/config.yaml`" in readme
    assert "`/home/hermes/.hermes/config.yaml`" not in readme
    paragraph = next(line for line in readme.splitlines() if "runtime Secret key" in line)
    for key in ("DISCORD_BOT_TOKEN", "OPENAI_API_KEY", "SKALD_API_KEY", "SKALD_PROJECT_ID"):
        assert f"`{key}`" in paragraph


def test_exact_runtime_command_and_recreate_assumption():
    manifest = yaml.safe_load((ROOT / "k8s" / "hermes-gateway-deployment.yaml").read_text())
    container = manifest["spec"]["template"]["spec"]["containers"][0]
    assert manifest["spec"]["strategy"]["type"] == "Recreate"
    assert container["command"] == ["hermes"]
    assert container["args"] == ["gateway", "run"]
    assert "hermes gateway run" in STATE_PATH.read_text()


def test_no_network_policy_or_calico_changes_in_slice():
    touched = {"k8s/deploy.sh", "k8s/hermes/deploy_state.py", "k8s/hermes/smoke.py", "k8s/tests/hermes_deploy_test.py"}
    assert not any("networkpolicy" in path.lower() or "calico" in path.lower() for path in touched)
