from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEPLOY_SCRIPT = ROOT / "k8s" / "deploy.sh"
DEPLOYMENT_PATH = ROOT / "k8s" / "functional-spec-mcp-deployment.yaml"
WORKER_PATH = ROOT / "k8s" / "functional-spec-mcp-worker.yaml"
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
    assert worker["spec"]["serviceName"] == "functional-spec-mcp-worker-c7e78651"
    assert worker["spec"]["updateStrategy"] == {"type": "OnDelete"}
    assert router["spec"]["template"]["spec"]["imagePullSecrets"] == [
        {"name": "ghcr-pull-secret"}
    ]
    assert worker_container["image"].startswith(
        "ghcr.io/jc01rho/sparrow-function-spec-mcp@sha256:"
    )
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
    assert worker["metadata"]["name"] == "functional-spec-mcp-worker-c7e78651"
    assert initial["metadata"]["name"] == "functional-spec-mcp-worker-c7e78651-active"
    assert initial["spec"]["selector"]["revision"] == "c7e78651"


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
    assert (
        'kubectl rollout status statefulset/functional-spec-mcp-worker-c7e78651 '
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
