from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]
DEPLOY_SCRIPT = ROOT / "k8s" / "deploy.sh"
DEPLOYMENT_PATH = ROOT / "k8s" / "functional-spec-mcp-deployment.yaml"
GATEWAY_PATH = ROOT / "k8s" / "functional-spec-mcp-gateway.yaml"
ROUTE_PATH = ROOT / "k8s" / "functional-spec-mcp-httproute.yaml"


def load_documents(path):
    return [document for document in yaml.safe_load_all(path.read_text()) if document]


def test_functional_spec_mcp_uses_single_recreated_session_aware_pod():
    documents = load_documents(DEPLOYMENT_PATH)
    deployment = next(document for document in documents if document["kind"] == "Deployment")
    container = deployment["spec"]["template"]["spec"]["containers"][0]

    assert deployment["spec"]["replicas"] == 1
    assert deployment["spec"]["strategy"] == {"type": "Recreate"}
    assert container["image"].startswith("ghcr.io/jc01rho/sparrow-function-spec-mcp@sha256:")
    assert container["readinessProbe"]["httpGet"] == {"path": "/healthz", "port": "http"}
    assert container["livenessProbe"]["httpGet"] == {"path": "/healthz", "port": "http"}
    assert {
        "name": "MCP_AUTH_TOKEN",
        "valueFrom": {
            "secretKeyRef": {
                "name": "functional-spec-mcp-secrets",
                "key": "MCP_AUTH_TOKEN",
            }
        },
    } in container["env"]


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

    assert "deploy_functional_spec_mcp()" in deploy_script
    assert 'kubectl rollout status deployment/functional-spec-mcp -n "$NAMESPACE"' in deploy_script
    main_body = deploy_script[
        deploy_script.index("main()"): deploy_script.index("show_help()")
    ]
    assert main_body.index("deploy_ingress") < main_body.index("deploy_functional_spec_mcp")
    assert main_body.index("deploy_functional_spec_mcp") < main_body.index(
        "verify_deployment"
    )
