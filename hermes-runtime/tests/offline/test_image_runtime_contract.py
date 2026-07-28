import re
from pathlib import Path

ROOT = Path(__file__).parents[2]


def test_image_is_pinned_and_runtime_argv_is_exact():
    dockerfile = (ROOT / "Dockerfile").read_text()
    lock = (ROOT / "versions.lock").read_text()

    assert re.search(r'^ENTRYPOINT \["hermes"\]$', dockerfile, re.MULTILINE)
    assert re.search(r'^CMD \["gateway", "run"\]$', dockerfile, re.MULTILINE)
    assert "--platform" not in dockerfile
    assert "sh -c" not in dockerfile
    assert "339d968689a3b91c5f537d7198ff28abde32ab3b" in dockerfile
    assert "c4b6941b4b7bfb054040960099616019a901e745" in dockerfile
    assert "python:3.12.11-slim-bookworm@sha256:" in dockerfile
    assert "BUN_VERSION=1.3.14" in lock


def test_workflow_runs_all_offline_pytest_and_pins_actions():
    workflow = (ROOT.parent / ".github" / "workflows" / "build-hermes-gateway.yml").read_text()

    assert "python -m pip install --disable-pip-version-check pytest==8.3.5 PyYAML==6.0.2" in workflow
    assert "python -m pytest hermes-runtime/tests/offline k8s/tests -v" in workflow
    assert workflow.count("- 'k8s/tests/**'") == 2
    assert "ssh-private-key: ${{ secrets.HERMES_GITLAB_DEPLOY_KEY }}" in workflow
    assert "ssh-keyscan -H gitlab.git.sparrow.local" in workflow
    assert "docker build --pull --ssh default" in workflow
    assert "= '[\"hermes\"]'" in workflow
    assert "= '[\"gateway\",\"run\"]'" in workflow
    assert ":latest" not in workflow

    action_uses = re.findall(r"^\s*uses:\s*([^\s#]+)", workflow, re.MULTILINE)
    assert action_uses == [
        "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
        "webfactory/ssh-agent@dc588b651fe13675774614f8e6a936a468676387",
        "aquasecurity/trivy-action@dc5a429b52fcf669ce959baa2c2dd26090d2a6c4",
        "anchore/sbom-action@fc46e51fd3cb168ffb36c6d1915723c47db58abb",
        "docker/login-action@74a5d142397b4f367a81961eba4e8cd7edddf772",
    ]
    assert all(re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", action) for action in action_uses)

    for private_image_step in (
        "Load GitLab deploy key",
        "Trust private GitLab host",
        "Build immutable commit image",
        "Verify image command",
        "Scan image vulnerabilities and secrets",
        "Generate SPDX SBOM",
    ):
        assert re.search(
            rf"- name: {re.escape(private_image_step)}\n\s+if: github\.event_name != 'pull_request'",
            workflow,
        )


def test_image_layout_keeps_full_checkouts_and_fixed_mcp_wrapper():
    dockerfile = (ROOT / "Dockerfile").read_text()
    config = (ROOT / "config" / "config.yaml.example").read_text()

    assert 'git clone https://github.com/NousResearch/hermes-agent.git "${HERMES_HOME}/hermes-agent"' in dockerfile
    assert "git clone git@gitlab.git.sparrow.local:mcp-servers/functional-spec.git /opt/sparrow-function-spec" in dockerfile
    assert "rm -rf /opt/sparrow-function-spec/.git" not in dockerfile
    assert "rm -rf \"${HERMES_HOME}/hermes-agent/.git\"" not in dockerfile
    assert "command: /bin/bash" in config
    assert "- /opt/sparrow-function-spec/scripts/run-with-auto-update.sh" in config
    assert config.count("sparrow-function-spec:") == 1
    assert "- sparrow-function-spec" in config


def test_docker_context_excludes_secret_bearing_local_state():
    ignored = (ROOT / ".dockerignore").read_text().splitlines()
    assert "**/.env" in ignored
    assert "**/.env.*" in ignored
    assert "**/auth.json" in ignored
    assert "**/sessions/" in ignored
    assert ".gjc/" in ignored
