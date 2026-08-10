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
WORKFLOW_PATH = ROOT / ".github" / "workflows" / "build-hermes-gateway.yml"



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
    module.AUTHORIZATION_LANE = module.AuthorizationLane.OPERATOR
    module.assert_current_identity = lambda: None
    return module
def run_deploy_with_env_file(tmp_path, content, caller_env=None):
    env_file = tmp_path / "deploy.env"
    env_file.write_text(content)
    env = os.environ.copy()
    for key in (
        "HERMES_IMAGE",
        "HERMES_CI_RECEIPT_FILE",
        "HERMES_PROVENANCE_BUNDLE",
        "HERMES_DEPLOY_MODE",
        "HERMES_DEPLOY_IDENTITY",
    ):
        env.pop(key, None)
    env.update(caller_env or {})
    env["ENV_FILE"] = str(env_file)
    return subprocess.run(
        ["bash", str(DEPLOY_SH), "-y"],
        cwd=ROOT / "k8s",
        env=env,
        capture_output=True,
        text=True,
    )

def run_env_file_entrypoint_probe(tmp_path, content):
    env_file = tmp_path / "deploy.env"
    env_file.write_text(content)
    event_file = tmp_path / "events"
    payload_file = tmp_path / "payload-ran"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()

    real_python = Path(os.environ.get("PYTHON", os.sys.executable)).resolve()
    python3 = bin_dir / "python3"
    python3.write_text(
        "#!/bin/sh\n"
        "case \"$1\" in *deploy_state.py) printf 'verifier\\n' >> \"$ENV_PROBE_EVENTS\"; exit 97 ;; esac\n"
        f"exec {str(real_python)!r} \"$@\"\n"
    )
    python3.chmod(0o755)
    kubectl = bin_dir / "kubectl"
    kubectl.write_text("#!/bin/sh\nprintf 'kubectl\\n' >> \"$ENV_PROBE_EVENTS\"\nexit 97\n")
    kubectl.chmod(0o755)
    payload = bin_dir / "env-payload"
    payload.write_text("#!/bin/sh\nprintf payload > \"$ENV_PROBE_PAYLOAD\"\n")
    payload.chmod(0o755)

    env = os.environ.copy()
    for key in (
        "HERMES_IMAGE",
        "HERMES_CI_RECEIPT_FILE",
        "HERMES_PROVENANCE_BUNDLE",
        "HERMES_DEPLOY_MODE",
        "HERMES_DEPLOY_IDENTITY",
    ):
        env.pop(key, None)
    env.update({
        "ENV_FILE": str(env_file),
        "ENV_PROBE_EVENTS": str(event_file),
        "ENV_PROBE_PAYLOAD": str(payload_file),
        "PATH": f"{bin_dir}{os.pathsep}{env['PATH']}",
    })
    completed = subprocess.run(
        ["bash", str(DEPLOY_SH), "-y"],
        cwd=ROOT / "k8s",
        env=env,
        capture_output=True,
        text=True,
    )
    events = event_file.read_text().splitlines() if event_file.exists() else []
    return completed, events, payload_file


def assert_env_file_rejected_without_execution(tmp_path, content):
    completed, events, payload_file = run_env_file_entrypoint_probe(tmp_path, content)
    assert completed.returncode == 64
    assert not payload_file.exists()
    assert "verifier" not in events
    assert "kubectl" not in events
    assert "data-only dotenv" in completed.stdout + completed.stderr


@pytest.mark.parametrize(
    "content",
    [
        "LOG_LEVEL=$(env-payload)\n",
        "LOG_LEVEL=`env-payload`\n",
        "env-payload() { env-payload; }\n",
        "function kubectl { env-payload; }\n",
        "LOG_LEVEL=ok; env-payload\n",
        "LOG_LEVEL=ok | env-payload\n",
        "LOG_LEVEL=ok\nprintf -v HERMES_PREVERIFIED_FILE env-payload\n",
        "LOG_LEVEL=first\nLOG_LEVEL=second\n",
        "LOG_LEVEL='unterminated\n",
    ],
)
def test_env_file_is_data_only_at_actual_entrypoint(tmp_path, content):
    assert_env_file_rejected_without_execution(tmp_path, content)


@pytest.mark.parametrize(
    "key",
    [
        "PATH",
        "BASH_ENV",
        "ENV",
        "SHELLOPTS",
        "BASHOPTS",
        "CDPATH",
        "PYTHONPATH",
        "PYTHONHOME",
        "KUBECTL",
        "GH",
    ],
)
def test_env_file_cannot_replace_command_or_python_import_surface(tmp_path, key):
    assert_env_file_rejected_without_execution(tmp_path, f"{key}=env-payload\n")


@pytest.mark.parametrize(
    "key",
    [
        "LD_PRELOAD",
        "LD_AUDIT",
        "LD_LIBRARY_PATH",
        "DYLD_INSERT_LIBRARIES",
        "HERMES_SKIP_DISCORD_SMOKE",
        "HERMES_CONFIGMAP_FILE",
        "HERMES_SMOKE_PROFILE",
        "HERMES_OPERATION_ACTOR",
        "HERMES_KUBECTL_TIMEOUT_SECONDS",
        "HERMES_LEASE_WAIT_SECONDS",
        "GH_HOST",
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_SYSTEM",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_VALUE_0",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "SSL_CERT_FILE",
        "REQUESTS_CA_BUNDLE",
        "UNKNOWN_DEPLOY_SETTING",
    ],
)
def test_env_file_allowlist_rejects_execution_and_provenance_controls(tmp_path, key):
    assert_env_file_rejected_without_execution(tmp_path, f"{key}=env-payload\n")


def test_env_file_accepts_supported_data_only_settings_without_shell_expansion(tmp_path):
    completed, events, payload_file = run_env_file_entrypoint_probe(
        tmp_path,
        "\n# local production settings\nexport POSTGRES_DB=skald2\nPOSTGRES_USER=postgres\n"
        "RABBITMQ_USER=skald\nUI_DOMAIN=ui.skald.local\nAPI_DOMAIN=api.skald.local\n"
        "LLM_PROVIDER=cli-proxy-api\nCLI_PROXY_API_BASE_URL='$(env-payload) literal'\n"
        "LLM_DEFAULT_CHAT_MODEL=parrot\nLLM_DEFAULT_CLASSIFICATION_MODEL=parrot\n"
        "LLM_FALLBACK_CHAIN=parrot\nEMBEDDING_PROVIDER=external\n"
        "DOCUMENT_EXTRACTION_PROVIDER=docling\nEMBEDDING_SERVICE_URL=http://embedding-service:8000\n"
        "LOCAL_EMBEDDING_MODEL=all-MiniLM-L6-v2\n"
        "LOCAL_RERANK_MODEL=cross-encoder/ms-marco-MiniLM-L-6-v2\nRERANK_PROVIDER=ollama\n"
        "QUERY_LANGUAGE=ko\nEXTERNAL_EMBEDDING_URL=http://embedding.local/embeddings\n"
        "INTERNAL_RERANK_URL=http://rerank.local/v1/rerank\nLOG_LEVEL=info\n",
    )
    assert completed.returncode != 0
    assert completed.returncode != 64
    assert events == ["verifier"]
    assert not payload_file.exists()
    assert "Environment variables loaded" in completed.stdout + completed.stderr


def test_env_file_failure_is_atomic_before_verifier(tmp_path):
    completed, events, _ = run_env_file_entrypoint_probe(
        tmp_path,
        "LOG_LEVEL=info\nLLM_PROVIDER='unterminated\n",
    )
    assert completed.returncode == 64
    assert events == []


def run_real_cli_handoff_harness(tmp_path, *, verifier_fails=False):
    event_file = tmp_path / "events"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    head_sha = "b" * 40
    digest = "sha256:" + "a" * 64
    image = "ghcr.io/jc01rho/hermes-gateway@" + digest
    receipt = {
        "schema_version": 1,
        "repository": "jc01rho/skald",
        "workflow_path": ".github/workflows/build-hermes-gateway.yml",
        "run_id": 7,
        "run_attempt": 2,
        "run_url": "https://github.com/jc01rho/skald/actions/runs/7/attempts/2",
        "event": "push",
        "ref": "refs/heads/main",
        "head_sha": head_sha,
        "conclusion": "success",
        "image_repository": "ghcr.io/jc01rho/hermes-gateway",
        "digest": digest,
        "subject": image,
    }
    receipt_path = tmp_path / "receipt.json"
    receipt_path.write_text(json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n")
    receipt_path.chmod(0o600)
    git = bin_dir / "git"
    git.write_text("#!/bin/sh\nprintf 'git %s\\n' \"$*\" >> \"$HERMES_TEST_EVENTS\"\nprintf '%s\\n' \"$HERMES_TEST_HEAD\"\n")
    git.chmod(0o755)
    gh = bin_dir / "gh"
    gh.write_text(
        "#!/bin/bash\n"
        "printf 'gh %s\\n' \"$*\" >> \"$HERMES_TEST_EVENTS\"\n"
        "if [ \"${HERMES_TEST_VERIFY_FAIL:-0}\" = 1 ]; then exit 23; fi\n"
        "case \"$1 $2\" in\n"
        "  '--version ') printf 'gh version 2.97.1 (fixture)\\n' ;;\n"
        "  'run download') while [ \"$1\" != '--dir' ]; do shift; done; mkdir -p \"$2\"; cp \"$HERMES_TEST_RECEIPT\" \"$2/hermes-gateway-receipt.json\" ;;\n"
        "  'api --method') last=; for arg in \"$@\"; do last=\"$arg\"; done; if [[ \"$last\" == *'/artifacts?'* ]]; then printf '%s' \"$HERMES_TEST_ARTIFACT\"; else printf '%s' \"$HERMES_TEST_RUN\"; fi ;;\n"
        "  *) exit 97 ;;\n"
        "esac\n"
    )
    gh.chmod(0o755)
    kubectl = bin_dir / "kubectl"
    kubectl.write_text(
        "#!/bin/sh\n"
        "printf 'kubectl %s\\n' \"$*\" >> \"$HERMES_TEST_EVENTS\"\n"
        "case \"$*\" in\n"
        "  *'get configmap skald-discord-owner-state'* ) printf '%s' \"$HERMES_TEST_OWNER\" ;;\n"
        "esac\n"
    )
    kubectl.chmod(0o755)
    harness = tmp_path / "deploy-harness.sh"
    harness.write_text(
        "#!/bin/bash\n"
        f"source {json.dumps(str(DEPLOY_SH))}\n"
        "check_prerequisites() { kubectl cluster-info; }\n"
        "create_namespace() { :; }\n"
        "deploy_traefik() { :; }\n"
        "create_configs() { :; }\n"
        "create_pvcs() { :; }\n"
        "deploy_infrastructure() { :; }\n"
        "deploy_backend() { :; }\n"
        "deploy_ai_services() { :; }\n"
        "deploy_worker() { :; }\n"
        "deploy_frontend() { :; }\n"
        "deploy_ingress() { :; }\n"
        "verify_deployment() { :; }\n"
        "print_access_info() { :; }\n"
        "main -y\n"
    )
    harness.chmod(0o700)
    run = {
        "id": 7, "run_attempt": 2, "html_url": "https://github.com/jc01rho/skald/actions/runs/7",
        "event": "push", "status": "completed", "conclusion": "success", "head_branch": "main",
        "head_sha": head_sha, "path": ".github/workflows/build-hermes-gateway.yml",
        "repository": {"full_name": "jc01rho/skald"},
    }
    artifact = {
        "name": "hermes-gateway-receipt-7-2", "expired": False, "digest": "sha256:" + "c" * 64,
        "workflow_run": {"id": 7, "head_sha": head_sha},
    }
    owner_record = {
        "schema_version": 1, "namespace": "skald", "active_owner": "legacy", "generation": 1,
        "legacy_snapshot_ref": "configmap://skald/skald-discord-legacy-" + "d" * 16,
        "hermes_verified_snapshot_ref": None, "verified_at": "2026-07-30T00:00:00Z",
        "verified_by": "test", "smoke": {},
    }
    (tmp_path / "ghcr-fixture.json").write_text(json.dumps({"digest": digest, "schemaVersion": 2}))
    owner = {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "skald-discord-owner-state", "namespace": "skald"}, "data": {"owner.json": json.dumps(owner_record, sort_keys=True, separators=(",", ":"))}}

    env = os.environ.copy()
    env.update({
        "PATH": f"{bin_dir}{os.pathsep}{env['PATH']}", "ENV_FILE": str(tmp_path / "missing.env"),
        "HERMES_IMAGE": image, "HERMES_CI_RECEIPT_FILE": str(receipt_path),
        "HERMES_TEST_EVENTS": str(event_file), "HERMES_TEST_HEAD": head_sha,
        "HERMES_TEST_RECEIPT": str(receipt_path), "HERMES_TEST_DIGEST": digest,
        "HERMES_TEST_GHCR_FIXTURE": str(tmp_path / "ghcr-fixture.json"),
        "HERMES_TEST_RUN": json.dumps(run, separators=(",", ":")),
        "HERMES_TEST_ARTIFACT": json.dumps({"total_count": 1, "artifacts": [artifact]}, separators=(",", ":")),
        "HERMES_TEST_OWNER": json.dumps(owner, separators=(",", ":")),
        "HERMES_TEST_VERIFY_FAIL": "1" if verifier_fails else "0",
    })
    completed = subprocess.run(["bash", str(harness)], cwd=ROOT / "k8s", env=env, capture_output=True, text=True)
    events = event_file.read_text().splitlines() if event_file.exists() else []
    return completed, events


def test_real_cli_handoff_verifies_once_before_kubernetes_and_late_dispatch_is_local(tmp_path):
    completed, events = run_real_cli_handoff_harness(tmp_path)
    assert completed.returncode != 0
    gh_events = [event for event in events if event.startswith("gh ")]
    assert len(gh_events) == 4
    first_kubectl = next(index for index, event in enumerate(events) if event.startswith("kubectl "))
    assert all(not event.startswith("kubectl ") for event in events[:first_kubectl])
    assert all(not event.startswith("gh ") for event in events[first_kubectl:])
    assert events.count("git rev-parse HEAD") == 2


def test_real_cli_verifier_failure_runs_zero_kubernetes_commands(tmp_path):
    completed, events = run_real_cli_handoff_harness(tmp_path, verifier_fails=True)
    assert completed.returncode != 0
    assert not any(event.startswith("kubectl ") for event in events)
    assert "candidate verification failed before Kubernetes access" in completed.stdout + completed.stderr



@pytest.mark.parametrize(
    "key",
    [
        "HERMES_IMAGE",
        "HERMES_CI_RECEIPT_FILE",
        "HERMES_PROVENANCE_BUNDLE",
        "HERMES_DEPLOY_MODE",
        "HERMES_DEPLOY_IDENTITY",
    ],
)
@pytest.mark.parametrize(
    "definition",
    [
        "{key}=value\n",
        "  export {key}=value\n",
        "{key}=\"value\"\n",
        "{key}=first\n{key}=second\n",
    ],
)
def test_reserved_hermes_env_file_inputs_fail_before_prerequisites(tmp_path, key, definition):
    completed = run_deploy_with_env_file(tmp_path, definition.format(key=key))
    assert completed.returncode == 64
    output = completed.stdout + completed.stderr
    assert f"{key} is not an allowed ENV_FILE setting" in output
    assert "사전 요구사항 확인 중" not in output
    assert "namespace" not in output.lower()
    assert "hermes/deploy_state.py" not in output



@pytest.mark.parametrize("key", [
    "HERMES_IMAGE_CALLER_VALUE",
    "HERMES_CI_RECEIPT_FILE_CALLER_VALUE",
    "HERMES_DEPLOY_MODE_CALLER_VALUE",
    "HERMES_UNRELATED_HELPER_CALLER_VALUE",
    "HERMES_PREVERIFIED_SHA256",
])
def test_env_file_cannot_override_internal_captures_or_handoff_hash(tmp_path, key):
    completed = run_deploy_with_env_file(tmp_path, f"{key}=attacker-controlled\n")
    assert completed.returncode == 64
    assert f"{key} is not an allowed ENV_FILE setting" in completed.stdout + completed.stderr
    assert "candidate verification failed" not in completed.stdout + completed.stderr


@pytest.mark.parametrize("mode", ["cutover", "upgrade"])
def test_explicit_candidate_modes_require_image_receipt_pair_before_verifier_or_kubernetes(tmp_path, mode):
    completed = run_deploy_with_env_file(
        tmp_path,
        "",
        {"HERMES_DEPLOY_MODE": mode, "HERMES_DEPLOY_IDENTITY": "user:alice"},
    )
    assert completed.returncode == 64
    output = completed.stdout + completed.stderr
    assert f"{mode} requires both HERMES_IMAGE and HERMES_CI_RECEIPT_FILE" in output
    assert "hermes/deploy_state.py" not in output
    assert "사전 요구사항 확인 중" not in output


def test_rollback_rejects_candidate_pair_before_verifier_or_kubernetes(tmp_path):
    completed = run_deploy_with_env_file(
        tmp_path,
        "",
        {
            "HERMES_DEPLOY_MODE": "rollback",
            "HERMES_DEPLOY_IDENTITY": "user:alice",
            "HERMES_IMAGE": "ghcr.io/jc01rho/hermes-gateway@sha256:" + "a" * 64,
            "HERMES_CI_RECEIPT_FILE": str(tmp_path / "receipt.json"),
        },
    )
    assert completed.returncode == 64
    output = completed.stdout + completed.stderr
    assert "rollback rejects HERMES_IMAGE and HERMES_CI_RECEIPT_FILE" in output
    assert "hermes/deploy_state.py" not in output
    assert "사전 요구사항 확인 중" not in output

def test_reserved_env_file_input_is_rejected_even_when_equal_to_caller(tmp_path):
    completed = run_deploy_with_env_file(
        tmp_path,
        'HERMES_IMAGE="same"\n',
        {"HERMES_IMAGE": "same"},
    )
    assert completed.returncode == 64
    assert "HERMES_IMAGE is not an allowed ENV_FILE setting" in completed.stdout + completed.stderr


def test_caller_provenance_bundle_is_rejected_before_prerequisites(tmp_path):
    completed = run_deploy_with_env_file(
        tmp_path,
        "LOG_LEVEL=info\n",
        {"HERMES_PROVENANCE_BUNDLE": str(tmp_path / "bundle.json")},
    )
    assert completed.returncode == 64
    output = completed.stdout + completed.stderr
    assert "only approved provenance protocol" in output
    assert "사전 요구사항 확인 중" not in output


def test_ordinary_candidate_requires_image_receipt_pair(tmp_path):
    for env in (
        {"HERMES_IMAGE": "ghcr.io/jc01rho/hermes-gateway@sha256:" + "a" * 64},
        {"HERMES_CI_RECEIPT_FILE": str(tmp_path / "receipt.json")},
    ):
        completed = run_deploy_with_env_file(tmp_path, "LOG_LEVEL=info\n", env)
        assert completed.returncode == 64
        assert "requires both HERMES_IMAGE and HERMES_CI_RECEIPT_FILE" in completed.stdout + completed.stderr


def test_ordinary_identity_and_explicit_missing_identity_fail_early(tmp_path):
    ordinary = run_deploy_with_env_file(tmp_path, "", {"HERMES_DEPLOY_IDENTITY": "user:alice"})
    assert ordinary.returncode == 64
    assert "not accepted for ordinary" in ordinary.stdout + ordinary.stderr

    explicit = run_deploy_with_env_file(tmp_path, "", {"HERMES_DEPLOY_MODE": "upgrade"})
    assert explicit.returncode == 64
    assert "requires caller HERMES_DEPLOY_IDENTITY" in explicit.stdout + explicit.stderr



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
        verb = command[command.index("can-i") + 1]
        target = command[command.index("can-i") + 2]
        resource = target.split("/", 1)[0]
        if "--subresource" in command:
            resource = f"{resource}/{command[command.index('--subresource') + 1]}"
        permission = (verb, resource)
        prohibited = {(item_verb, item_resource) for item_verb, item_resource, _ in state.PROHIBITED_PERMISSIONS}
        allowed = permission not in prohibited
        return SimpleNamespace(returncode=0 if allowed else 1, stdout=b"yes\n" if allowed else b"no\n", stderr=b"")

    monkeypatch.setattr(state.subprocess, "run", run)
    state.verify_operator_identity()
    assert state.IDENTITY_VERIFIED is True
    permission_calls = [call for call in calls if "can-i" in call]
    assert len(permission_calls) == len(state.PROHIBITED_PERMISSIONS) + len(state.OPERATOR_PERMISSIONS) + 1
    assert any("leases.coordination.k8s.io/skald-discord-deploy-operation" in call for call in permission_calls)
    assert any(any("hermes-gateway" in part for part in call) for call in permission_calls)
    assert any(any("discord-bot" in part for part in call) for call in permission_calls)
    assert any(any("http:discord-bot-service:3000" in part for part in call) and "--subresource" in call for call in permission_calls)
    assert any("deletecollection" in call and "secrets" in call for call in permission_calls)
    assert any("delete" in call and any("skald-discord-legacy-0123456789abcdef" in part for part in call) for call in permission_calls)
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
        verb = command[command.index("can-i") + 1]
        target = command[command.index("can-i") + 2]
        resource = target.split("/", 1)[0]
        if "--subresource" in command:
            resource = f"{resource}/{command[command.index('--subresource') + 1]}"
        permission = (verb, resource)
        prohibited = {(item_verb, item_resource) for item_verb, item_resource, _ in state.PROHIBITED_PERMISSIONS}
        allowed = permission == prohibited_grant or permission not in prohibited
        return SimpleNamespace(returncode=0 if allowed else 1, stdout=b"yes\n" if allowed else b"no\n", stderr=b"")

    def current_snapshot_names(_):
        return ()

    monkeypatch.setattr(state, "current_snapshot_names", current_snapshot_names)

    monkeypatch.setattr(state.subprocess, "run", run)
    mutated = []
    monkeypatch.setattr(state, "dispatch", lambda *_: mutated.append("dispatch"))
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


def test_deploy_script_separates_ordinary_and_explicit_identity_and_rbac_scopes_snapshot_pruning():
    text = DEPLOY_SH.read_text()
    dispatch = text[text.index("deploy_discord_owner()") : text.index("deploy_discord_bot()")]
    assert 'state_command=(python3 "$SCRIPT_DIR/hermes/deploy_state.py" dispatch --mode "$HERMES_DEPLOY_MODE")' in dispatch
    assert 'NAMESPACE="$NAMESPACE" HERMES_DEPLOY_IDENTITY=' not in dispatch
    rbac = yaml.safe_load_all((ROOT / "k8s" / "hermes-deploy-operator-rbac.yaml").read_text())
    objects = list(rbac)
    operator_role = next(obj for obj in objects if obj["kind"] == "Role" and obj["metadata"]["name"] == "hermes-deploy-operator")
    binding = next(obj for obj in objects if obj["kind"] == "RoleBinding" and obj["metadata"]["name"] == "hermes-deploy-operator")
    assert binding["subjects"] == [{"kind": "Group", "name": "hermes-deploy-operators", "apiGroup": "rbac.authorization.k8s.io"}]

    grants = {
        (tuple(rule["apiGroups"]), tuple(rule["resources"]), tuple(rule.get("resourceNames", [])), tuple(rule["verbs"]))
        for rule in operator_role["rules"]
    }
    assert (("coordination.k8s.io",), ("leases",), ("skald-discord-deploy-operation",), ("get", "update")) in grants
    lease_rule = next(rule for rule in operator_role["rules"] if rule["resources"] == ["leases"])
    assert "patch" not in lease_rule["verbs"]
    assert "create" not in lease_rule["verbs"]
    assert "delete" not in lease_rule["verbs"]
    deployment_rules = [rule for rule in operator_role["rules"] if rule["resources"] == ["deployments"]]
    assert any("patch" in rule["verbs"] for rule in deployment_rules)
    assert all("delete" not in rule["verbs"] and "deletecollection" not in rule["verbs"] for rule in operator_role["rules"])

    pruner_role = next(obj for obj in objects if obj["kind"] == "Role" and obj["metadata"]["name"] == "hermes-snapshot-pruner")
    pruner_binding = next(obj for obj in objects if obj["kind"] == "RoleBinding" and obj["metadata"]["name"] == "hermes-snapshot-pruner")
    assert pruner_binding["subjects"] == [{"kind": "Group", "name": "hermes-snapshot-pruners", "apiGroup": "rbac.authorization.k8s.io"}]
    pruner_rules = {
        (tuple(rule["apiGroups"]), tuple(rule["resources"]), tuple(rule.get("resourceNames", [])), tuple(rule["verbs"]))
        for rule in pruner_role["rules"]
    }
    assert (("coordination.k8s.io",), ("leases",), ("skald-discord-deploy-operation",), ("get", "update")) in pruner_rules
    assert (("",), ("configmaps",), (), ("get", "list", "delete")) in pruner_rules
    assert all("secrets" not in rule["resources"] and "deletecollection" not in rule["verbs"] for rule in pruner_role["rules"])


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
    monkeypatch.delenv("HERMES_IMAGE", raising=False)
    monkeypatch.setattr(state, "load_owner", lambda required=True: ({}, owner("legacy")))
    assert state.dispatch("") == "ordinary-legacy-noop"



def test_unknown_mode_rejects_before_cluster_read(monkeypatch):
    state = load_state()
    monkeypatch.setattr(state, "load_owner", lambda **_: pytest.fail("must not read owner"))
    with pytest.raises(state.Exit) as caught:
        state.dispatch("deploy")
    assert caught.value.code == 64


def test_ordinary_deploy_never_starts_legacy_and_accepts_only_terminal_contract():
    text = DEPLOY_SH.read_text()
    callsite = text[text.index("deploy_discord_owner()") : text.index("deploy_discord_bot()")]
    assert "deploy_discord_bot" not in callsite
    for result in ("ordinary-legacy-noop", "hermes-noop", "hermes-reconciled", "managed"):
        assert f"{result})" in callsite
    for failure in ("restored_after_failed_rollout", "blocked", "result_unknown"):
        assert failure not in callsite
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



def test_workflow_emits_exact_canonical_receipt_and_uploads_it_last():
    workflow = yaml.safe_load(WORKFLOW_PATH.read_text())
    steps = workflow["jobs"]["build-test-scan-push"]["steps"]
    generate = next(step for step in steps if step["name"] == "Generate canonical Hermes gateway receipt")
    upload = steps[-1]
    assert upload["name"] == "Upload Hermes gateway receipt"
    assert upload["if"] == "github.event_name != 'pull_request'"
    assert upload["uses"] == "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"
    assert upload["with"] == {
        "name": "hermes-gateway-receipt-${{ github.run_id }}-${{ github.run_attempt }}",
        "path": "hermes-gateway-receipt.json",
        "if-no-files-found": "error",
        "compression-level": 0,
        "retention-days": 30,
        "overwrite": False,
        "include-hidden-files": False,
    }
    script = generate["run"]
    expected_keys = {
        "schema_version", "repository", "workflow_path", "run_id", "run_attempt",
        "run_url", "event", "ref", "head_sha", "conclusion", "image_repository",
        "digest", "subject",
    }
    assert {key for key in expected_keys if f'"{key}"' in script} == expected_keys
    assert 'json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\\n"' in script
    assert steps.index(generate) > next(i for i, step in enumerate(steps) if step["name"] == "Push immutable commit image")


def test_workflow_has_no_attestation_protocol_or_permissions():
    text = WORKFLOW_PATH.read_text()
    for forbidden in ("attest-build-provenance", "gh attestation", "id-token: write", "attestations: write"):
        assert forbidden not in text


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
    monkeypatch.setattr(state, "smoke_evidence", lambda value: events.append(f"smoke:{value}") or ({"profile": value, "correlation_id": "id", "completed_at": "now"} if value == "legacy" else (_ for _ in ()).throw(state.Exit(70, "candidate failed"))))
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
    monkeypatch.setattr(state, "smoke_evidence", lambda owner: events.append(f"smoke:{owner}") or {})
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
    state = load_state()
    smoke_body = STATE_PATH.read_text()[STATE_PATH.read_text().index("def smoke(owner:") : STATE_PATH.read_text().index("def publish_owner(")]
    assert "stdout=subprocess.PIPE" not in smoke_body
    assert "stderr=subprocess.PIPE" not in smoke_body
    assert state.SMOKE_TIMEOUT_SECONDS == 3600
    assert state.SMOKE_PROCESS_GRACE_SECONDS == 30
    assert '"--timeout-seconds", str(SMOKE_TIMEOUT_SECONDS)' in smoke_body
    assert "timeout=SMOKE_TIMEOUT_SECONDS + SMOKE_PROCESS_GRACE_SECONDS" in smoke_body

def test_user_approved_smoke_skip_is_explicit_and_auditable(monkeypatch):
    state = load_state()
    monkeypatch.setattr(state, "SMOKE_DISABLED", True)
    monkeypatch.setattr(state, "smoke", lambda _: pytest.fail("interactive smoke must not run"))
    evidence = state.smoke_evidence("hermes")
    assert evidence["profile"] == "hermes-functional-spec"
    assert evidence["correlation_id"] == "user-approved-skip"
    assert evidence["completed_at"].endswith("Z")

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
