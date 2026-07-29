import hashlib
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
    assert "c4b6941b4b7bfb054040960099616019a901e745" not in dockerfile
    assert "git" in dockerfile
    assert "bash" in dockerfile
    assert "BUN_VERSION=1.3.14" in dockerfile
    python_base = "python:3.12.13-slim-trixie@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de"
    assert f"ARG PYTHON_BASE={python_base}" in dockerfile
    assert f"PYTHON_BASE={python_base}" in lock
    assert "slim-bookworm" not in dockerfile
    assert "BUN_VERSION=1.3.14" in lock
    assert "SPARROW_FUNCTION_SPEC_SOURCE=https://gitlab.git.sparrow.local/mcp-servers/functional-spec.git" in lock



def test_security_patch_is_pinned_and_updates_manifests_together():
    dockerfile = (ROOT / "Dockerfile").read_text()
    versions = dict(
        line.split("=", 1)
        for line in (ROOT / "versions.lock").read_text().splitlines()
        if line and not line.startswith("#")
    )
    patch_path = ROOT / versions["HERMES_SECURITY_PATCH"]

    assert patch_path.is_file()
    assert hashlib.sha256(patch_path.read_bytes()).hexdigest() == versions["HERMES_SECURITY_PATCH_SHA256"]
    assert f"ARG HERMES_SECURITY_PATCH={versions['HERMES_SECURITY_PATCH']}" in dockerfile
    assert f"ARG HERMES_SECURITY_PATCH_SHA256={versions['HERMES_SECURITY_PATCH_SHA256']}" in dockerfile
    assert "git -C \"${HERMES_HOME}/hermes-agent\" apply --check /tmp/hermes-security.patch" in dockerfile
    assert dockerfile.index("apply --check") < dockerfile.index("uv sync --frozen --no-dev")
    assert "uv sync --frozen --no-dev" in dockerfile
    assert "uv lock" not in dockerfile
    assert "uv pip install" not in dockerfile

    patch = patch_path.read_text()
    assert "diff --git a/pyproject.toml b/pyproject.toml" in patch
    assert "diff --git a/uv.lock b/uv.lock" in patch
    assert '+  "Pillow==12.3.0",' in patch
    assert '+  "cryptography==48.0.1"' in patch
    assert '"starlette==1.3.1"' in patch
    assert '"python-multipart==0.0.32"' in patch
    assert '+version = "12.3.0"' in patch
    assert '+version = "48.0.1"' in patch
    assert '+version = "1.3.1"' in patch
    assert '+version = "0.0.32"' in patch
    assert '"mcp==1.28.1"' in patch
    assert '+version = "1.28.1"' in patch
    assert '-mcp = ["mcp==1.26.0"' in patch
    assert "Briefly introduce yourself without advertising slash commands." in patch
    assert "+                \"Briefly introduce yourself and mention that /help shows available commands." not in patch


def test_workflow_runs_all_offline_pytest_and_pins_actions():
    workflow = (ROOT.parent / ".github" / "workflows" / "build-hermes-gateway.yml").read_text()

    assert "python -m pip install --disable-pip-version-check pytest==8.3.5 PyYAML==6.0.2" in workflow
    assert "python -m pytest hermes-runtime/tests/offline k8s/tests -v" in workflow
    assert workflow.count("- 'k8s/tests/**'") == 2
    assert re.search(
        r"- name: Run offline runtime and deployment tests\n\s+run: python -m pytest hermes-runtime/tests/offline k8s/tests -v",
        workflow,
    )
    assert "pull_request:" in workflow
    assert "push:" in workflow
    assert "HERMES_GITLAB_DEPLOY_KEY" not in workflow
    assert "webfactory/ssh-agent" not in workflow
    assert "ssh-keyscan" not in workflow
    assert "docker build --pull --file hermes-runtime/Dockerfile" in workflow
    assert "--ssh" not in workflow
    assert "= '[\"hermes\"]'" in workflow
    assert "= '[\"gateway\",\"run\"]'" in workflow
    assert ":latest" not in workflow
    assert re.search(r"severity:\s*HIGH,CRITICAL", workflow)
    assert re.search(r"exit-code:\s*['\"]?1['\"]?", workflow)
    assert "exit-code: '0'" not in workflow
    assert "severity: CRITICAL" not in workflow

    action_uses = re.findall(r"^\s*uses:\s*([^\s#]+)", workflow, re.MULTILINE)
    assert action_uses == [
        "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
        "aquasecurity/trivy-action@c07df6fec6fa692e6fd1200d50aaa1fdd66f03c8",
        "docker/login-action@74a5d142397b4f367a81961eba4e8cd7edddf772",
    ]
    assert all(re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", action) for action in action_uses)

    for image_step in (
        "Build immutable commit image",
        "Verify image command",
        "Scan image vulnerabilities and secrets",
    ):
        assert re.search(
            rf"- name: {re.escape(image_step)}\n\s+if: github\.event_name != 'pull_request'",
            workflow,
        )


def test_image_layout_and_runtime_functional_spec_acquisition():
    dockerfile = (ROOT / "Dockerfile").read_text()
    manifest = (ROOT.parent / "k8s" / "hermes-gateway-deployment.yaml").read_text()
    config = (ROOT / "config" / "config.yaml.example").read_text()

    source = "https://gitlab.git.sparrow.local/mcp-servers/functional-spec.git"
    revision = "c4b6941b4b7bfb054040960099616019a901e745"

    assert 'git clone https://github.com/NousResearch/hermes-agent.git "${HERMES_HOME}/hermes-agent"' in dockerfile
    assert "uv sync --frozen --no-dev --extra mcp" in dockerfile
    assert source not in dockerfile
    assert revision not in dockerfile
    assert "http.sslVerify=false" not in dockerfile
    assert "rm -rf \"${HERMES_HOME}/hermes-agent/.git\"" not in dockerfile
    assert "command: ['hermes']" in manifest
    assert "args: ['gateway', 'run']" in manifest
    assert manifest.count("image: HERMES_IMAGE") == 2
    assert f"git -c http.sslVerify=false clone {source} /opt/sparrow-function-spec" in manifest
    assert "find /opt/sparrow-function-spec -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +" in manifest
    assert "rm -rf /opt/sparrow-function-spec/*" not in manifest
    assert "|| true" not in manifest
    assert manifest.count("http.sslVerify=false") == 1
    assert "git@gitlab.git.sparrow.local" not in manifest
    assert "--mount=type=ssh" not in manifest
    assert "GIT_SSL_NO_VERIFY" not in manifest
    assert "git config" not in manifest
    assert f"git -C /opt/sparrow-function-spec checkout --detach {revision}" in manifest
    assert f'test "$(git -C /opt/sparrow-function-spec rev-parse HEAD)" = "{revision}"' in manifest
    assert "bun install --frozen-lockfile" in manifest
    assert "chown -R" not in manifest
    assert manifest.count("name: sparrow-function-spec") == 4
    assert manifest.count("mountPath: /opt/sparrow-function-spec") == 2
    assert "emptyDir: {}" in manifest
    assert manifest.count("runAsNonRoot: true") >= 2
    assert manifest.count("runAsUser: 10001") >= 2
    assert manifest.count("runAsGroup: 10001") >= 2
    assert manifest.count("name: GIT_CONFIG_COUNT") == 2
    assert manifest.count("name: GIT_CONFIG_KEY_0") == 2
    assert manifest.count("name: GIT_CONFIG_VALUE_0") == 2
    assert manifest.count("value: safe.directory") == 2
    assert "command: /bin/bash" in config
    assert "- /opt/sparrow-function-spec/scripts/run-with-auto-update.sh" in config
    assert config.count("sparrow-function-spec:") == 1
    assert "platform_toolsets:\n  discord: []" in config
    assert "provider: skald-proxy" in config
    assert "key_env: OPENAI_API_KEY" in config
    assert "${OPENAI_MODEL}" not in config
    assert "${OPENAI_BASE_URL}" not in config
    assert "disabled_toolsets:\n    - kanban" in config
    assert "PATH: /opt/bun/bin:/usr/local/bin:/usr/bin:/bin" in config
    assert 'GIT_SSL_NO_VERIFY: "true"' in config
    assert "name: DISCORD_ALLOW_ALL_USERS" in manifest
    assert "key: DISCORD_ALLOW_ALL_USERS" in manifest
    assert "name: DISCORD_ALLOWED_USERS" not in manifest
    assert "name: DISCORD_ALLOWED_CHANNELS" in manifest
    assert "key: DISCORD_ALLOWED_CHANNELS" in manifest
    assert "name: DISCORD_HOME_CHANNEL" in manifest
    assert "key: DISCORD_HOME_CHANNEL" in manifest
    assert "name: DISCORD_HOME_CHANNEL_NAME" in manifest
    assert "key: DISCORD_HOME_CHANNEL_NAME" in manifest
    assert "DISCORD_ALLOW_ALL_USERS" in manifest
    assert "skald.io/hermes-config-revision: 'functional-spec-v6'" in manifest
    assert 'allowed_channels: "*"' in config
    assert "slash_commands: false" in config
    assert "onboarding:\n  profile_build: off" in config
    assert "mountPath: /var/lib/hermes/SOUL.md" in manifest
    assert "subPath: SOUL.md" in manifest
    assert "key: SOUL.md" in manifest
    configmap = (ROOT.parent / "k8s" / "hermes-gateway-configmap.yaml.example").read_text()
    assert "http://spms.sparrow.local/enterprise/information/<id>" in configmap
    assert "/information/1337" in configmap
    assert "http://spms.sparrow.local/enterprise/information/1337" in configmap


def test_docker_context_excludes_secret_bearing_local_state():
    ignored = (ROOT / ".dockerignore").read_text().splitlines()
    assert "**/.env" in ignored
    assert "**/.env.*" in ignored
    assert "**/auth.json" in ignored
    assert "**/sessions/" in ignored
    assert ".gjc/" in ignored
