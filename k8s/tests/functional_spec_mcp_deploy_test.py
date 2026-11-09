import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEPLOY_SCRIPT = ROOT / "k8s" / "deploy.sh"
DEPLOYMENT_PATH = ROOT / "k8s" / "functional-spec-mcp-deployment.yaml"
WORKER_PATH = ROOT / "k8s" / "functional-spec-mcp-worker.yaml"
CONFIGMAP_PATH = ROOT / "k8s" / "functional-spec-mcp-configmap.yaml"
GATEWAY_PATH = ROOT / "k8s" / "functional-spec-mcp-gateway.yaml"
ROUTE_PATH = ROOT / "k8s" / "functional-spec-mcp-httproute.yaml"


def load_documents(path):
    return [document for document in yaml.safe_load_all(path.read_text()) if document]


def test_functional_spec_mcp_uses_stateless_router_and_revision_workers():
    documents = load_documents(DEPLOYMENT_PATH)
    router = next(
        document
        for document in documents
        if document["kind"] == "Deployment"
        and document["metadata"]["name"] == "functional-spec-mcp-router"
    )
    worker = load_documents(WORKER_PATH)[0]
    router_container = router["spec"]["template"]["spec"]["containers"][0]
    worker_container = worker["spec"]["template"]["spec"]["containers"][0]

    assert router["spec"]["replicas"] == 2
    assert router["spec"]["strategy"] == {
        "type": "RollingUpdate",
        "rollingUpdate": {"maxUnavailable": 0, "maxSurge": 1},
    }
    assert worker["spec"]["replicas"] == 2
    assert worker["spec"]["serviceName"] == "functional-spec-mcp-worker-f42297a0"
    assert worker["spec"]["updateStrategy"] == {"type": "OnDelete"}
    assert router["spec"]["template"]["spec"]["imagePullSecrets"] == [
        {"name": "ghcr-pull-secret"}
    ]
    assert worker_container["image"].startswith(
        "ghcr.io/jc01rho/sparrow-function-spec-mcp@sha256:"
    )
    assert router_container["resources"]["limits"]["memory"] == "512Mi"
    assert router_container["readinessProbe"]["httpGet"] == {
        "path": "/readyz",
        "port": "http",
    }
    assert worker_container["readinessProbe"]["httpGet"] == {
        "path": "/readyz",
        "port": "http",
    }
    assert worker_container["livenessProbe"]["httpGet"] == {
        "path": "/healthz",
        "port": "http",
    }
    assert worker_container["lifecycle"]["preStop"]["httpGet"] == {
        "path": "/drain",
        "port": "http",
    }
    assert worker_container["env"][0] == {
        "name": "MCP_SESSION_POD_NAME",
        "valueFrom": {"fieldRef": {"fieldPath": "metadata.name"}},
    }
    assert worker["spec"]["template"]["spec"]["terminationGracePeriodSeconds"] == 300


def test_functional_spec_mcp_services_keep_initial_and_session_routing_separate():
    services = load_documents(ROOT / "k8s" / "functional-spec-mcp-service.yaml")
    router, worker, initial = services

    assert router["metadata"]["name"] == "functional-spec-mcp"
    assert router["spec"]["selector"]["component"] == "functional-spec-mcp-router"
    assert worker["spec"]["clusterIP"] == "None"
    assert worker["spec"]["publishNotReadyAddresses"] is True
    assert worker["metadata"]["name"] == "functional-spec-mcp-worker-f42297a0"
    assert initial["metadata"]["name"] == "functional-spec-mcp-worker-f42297a0-active"
    assert initial["spec"]["selector"]["revision"] == "f42297a0"


def test_functional_spec_mcp_config_has_no_stale_draining_revision():
    worker_config, router_config = load_documents(CONFIGMAP_PATH)

    assert worker_config["metadata"]["name"] == "functional-spec-mcp-worker-config-f42297a0"
    assert router_config["data"]["MCP_ROUTER_ACTIVE_REVISION"] == "f42297a0"
    assert router_config["data"]["MCP_ROUTER_DRAINING_REVISIONS"] == ""


def test_functional_spec_mcp_uses_its_own_envoy_gateway_and_mcp_route():
    certificate, gateway = load_documents(GATEWAY_PATH)
    route = load_documents(ROUTE_PATH)[0]

    assert certificate["spec"]["dnsNames"] == ["mcp.skald.sparrow.local"]
    assert gateway["spec"]["gatewayClassName"] == "envoy-gateway-small-class"
    assert gateway["spec"]["listeners"][0]["allowedRoutes"]["namespaces"]["from"] == "Same"
    assert route["spec"]["parentRefs"] == [
        {"name": "functional-spec-mcp-gateway", "sectionName": "https"}
    ]
    assert route["spec"]["hostnames"] == ["mcp.skald.sparrow.local"]
    assert route["spec"]["rules"][0]["matches"][0]["path"] == {
        "type": "PathPrefix",
        "value": "/mcp",
    }


def test_deploy_script_applies_and_waits_for_functional_spec_mcp():
    deploy_script = DEPLOY_SCRIPT.read_text()

    assert "ensure_functional_spec_mcp_session_secret()" in deploy_script
    assert "functional-spec-mcp-session-routing" in deploy_script
    assert "deploy_functional_spec_mcp()" in deploy_script
    assert 'kubectl rollout status deployment/functional-spec-mcp-router -n "$NAMESPACE"' in deploy_script
    assert 'updateStrategy.type' in deploy_script
    assert 'StatefulSet revision is not converged for OnDelete strategy' in deploy_script
    assert "jsonpath='{.status.updatedReplicas}'" in deploy_script
    assert "jsonpath='{.status.currentRevision}'" not in deploy_script
    assert (
        'kubectl rollout status statefulset/functional-spec-mcp-worker-f42297a0 '
        '-n "$NAMESPACE"'
    ) not in deploy_script
    main_body = deploy_script[
        deploy_script.index("main()"): deploy_script.index("show_help()")
    ]
    assert main_body.index("deploy_ingress") < main_body.index("deploy_functional_spec_mcp")
    assert main_body.index("deploy_functional_spec_mcp") < main_body.index(
        "verify_deployment"
    )


def test_deploy_script_waits_for_new_workers_before_router_cutover():
    deploy_script = DEPLOY_SCRIPT.read_text()

    worker_apply = deploy_script.index(
        'kubectl apply -f functional-spec-mcp-worker.yaml -n "$NAMESPACE"'
    )
    worker_ready = deploy_script.index(
        'statefulset/"$worker_statefulset" -n "$NAMESPACE" --timeout=300s'
    )
    router_apply = deploy_script.index(
        'kubectl apply -f functional-spec-mcp-deployment.yaml -n "$NAMESPACE"'
    )

    assert worker_apply < worker_ready < router_apply


def test_deploy_script_retires_drained_functional_spec_mcp_revisions():
    deploy_script = DEPLOY_SCRIPT.read_text()

    previous_draining_revisions = deploy_script.index(
        'previous_draining_revisions="$(kubectl get configmap '
        'functional-spec-mcp-router-config'
    )
    configmap_apply = deploy_script.index("functional-spec-mcp-configmap.yaml \\")
    router_rollout = deploy_script.index(
        'kubectl rollout status deployment/functional-spec-mcp-router '
        '-n "$NAMESPACE" --timeout=300s',
        configmap_apply,
    )
    retire = deploy_script.index("retire_drained_functional_spec_mcp_revisions", router_rollout)
    certificate_wait = deploy_script.index(
        'kubectl wait --for=condition=Ready certificate/functional-spec-mcp-tls'
    )

    assert previous_draining_revisions < configmap_apply < router_rollout < retire < certificate_wait
    assert 'http://127.0.0.1:8080/drain"' in deploy_script
    assert 'http://127.0.0.1:8080/drain-status"' in deploy_script
    assert '[ "$session_count" -gt 0 ]' in deploy_script
    assert 'kubectl delete statefulset "functional-spec-mcp-worker-$revision"' in deploy_script
    assert 'kubectl delete configmap "functional-spec-mcp-worker-config-$revision"' in deploy_script
    assert '--ignore-not-found=true' in deploy_script

BUSY_REVISION = "aaaa1111"
IDLE_REVISION = "bbbb2222"


def _write_harness(tmp_path, busy_sessions):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "kubectl.log"

    (bin_dir / "kubectl").write_text(
        "#!/bin/bash\n"
        'printf "%s\\n" "$*" >> "$KUBECTL_LOG"\n'
        'case "$*" in\n'
        '  *"get pods"*)\n'
        f'    if [[ "$*" == *"revision={BUSY_REVISION}"* ]]; then echo pod/busy-0; else echo pod/idle-0; fi\n'
        "    ;;\n"
        '  *"exec"*)\n'
        '    if [[ "$*" == *"busy-0"* ]]; then echo "${BUSY_SESSIONS}"; else echo 0; fi\n'
        "    ;;\n"
        "  *) echo ok ;;\n"
        "esac\n"
    )
    (bin_dir / "kubectl").chmod(0o755)

    harness = tmp_path / "harness.sh"
    harness.write_text(
        "set -u\n"
        f'export PATH="{bin_dir}:$PATH"\n'
        f'export KUBECTL_LOG="{log}"\n'
        f'export BUSY_SESSIONS="{busy_sessions}"\n'
        "export FUNCTIONAL_SPEC_MCP_DRAIN_TIMEOUT_SECONDS=0\n"
        f'source "{DEPLOY_SCRIPT}"\n'
        "rc=0\n"
        f'retire_drained_functional_spec_mcp_revisions "{BUSY_REVISION},{IDLE_REVISION}" "" active9999 || rc=$?\n'
        'echo "RETIRE_RC=$rc"\n'
    )
    return harness, log


def _run(harness):
    return subprocess.run(["bash", str(harness)], capture_output=True, text=True, timeout=120)


def test_retire_keeps_busy_revision_draining_without_failing_deploy(tmp_path):
    harness, log = _write_harness(tmp_path, busy_sessions=1)

    result = _run(harness)

    assert result.returncode == 0, result.stderr
    assert "RETIRE_RC=0" in result.stdout, result.stdout
    calls = log.read_text()
    patch_lines = [
        line for line in calls.splitlines() if line.startswith("patch configmap")
    ]
    assert len(patch_lines) == 1, calls
    assert BUSY_REVISION in patch_lines[0]
    assert IDLE_REVISION not in patch_lines[0]
    assert f"delete statefulset functional-spec-mcp-worker-{IDLE_REVISION}" in calls
    assert f"delete statefulset functional-spec-mcp-worker-{BUSY_REVISION}" not in calls
    assert "rollout restart deployment/functional-spec-mcp-router" in calls


def test_retire_deletes_every_idle_revision_without_touching_draining_list(tmp_path):
    harness, log = _write_harness(tmp_path, busy_sessions=0)

    result = _run(harness)

    assert result.returncode == 0, result.stderr
    assert "RETIRE_RC=0" in result.stdout, result.stdout
    calls = log.read_text()
    assert f"delete statefulset functional-spec-mcp-worker-{BUSY_REVISION}" in calls
    assert f"delete statefulset functional-spec-mcp-worker-{IDLE_REVISION}" in calls
    assert "patch configmap functional-spec-mcp-router-config" not in calls
    assert "rollout restart deployment/functional-spec-mcp-router" not in calls
