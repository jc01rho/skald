import importlib.util
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).parents[2]
REPOSITORY_ROOT = ROOT.parent
MODULE_PATH = ROOT / "tools" / "generate_required_secret_keys.py"
SPEC = importlib.util.spec_from_file_location("required_keys", MODULE_PATH)
required_keys = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(required_keys)


def test_source_derived_contract_traverses_container_structures_and_is_value_blind():
    manifest = """
    apiVersion: apps/v1
    kind: Deployment
    spec:
      template:
        spec:
          initContainers:
            - name: prepare
              env:
                - {name: SKALD_PROJECT_ID, valueFrom: {secretKeyRef: {key: SKALD_PROJECT_ID, name: hermes-gateway}}}
          containers:
            - name: gateway
              env:
                - name: DISCORD_BOT_TOKEN
                  valueFrom:
                    secretKeyRef: {key: DISCORD_BOT_TOKEN, name: hermes-gateway}
                - valueFrom:
                    secretKeyRef:
                      key: OPENAI_API_KEY
                      name: hermes-gateway
                  name: OPENAI_API_KEY
                - {name: ORDINARY_SETTING, value: not-a-secret}
                - {valueFrom: {secretKeyRef: {name: hermes-gateway, key: DISCORD_BOT_TOKEN}}, name: DISCORD_BOT_TOKEN}
    """
    assert required_keys.required_secret_keys(manifest) == (
        "DISCORD_BOT_TOKEN",
        "OPENAI_API_KEY",
        "SKALD_PROJECT_ID",
    )


def test_non_container_secret_refs_are_not_part_of_runtime_env_contract():
    manifest = """
    apiVersion: v1
    kind: Secret
    stringData: {key: value}
---
    apiVersion: apps/v1
    kind: Deployment
    spec:
      template:
        spec:
          volumes:
            - secret: {secretName: unrelated}
          containers:
            - name: gateway
              env:
                - {name: TOKEN, valueFrom: {secretKeyRef: {name: runtime, key: TOKEN}}}
    """
    assert required_keys.required_secret_keys(manifest) == ("TOKEN",)


def test_manifest_without_container_secret_refs_fails():
    with pytest.raises(ValueError, match="no container env secretKeyRef"):
        required_keys.required_secret_keys("apiVersion: apps/v1\nkind: Deployment\nspec: {}\n")


def test_repository_deployment_and_secret_example_do_not_drift():
    deployment = REPOSITORY_ROOT / "k8s" / "hermes-gateway-deployment.yaml"
    secret_example = REPOSITORY_ROOT / "k8s" / "hermes-gateway-secret.yaml.example"
    assert deployment.is_file(), f"required manifest is missing: {deployment}"
    assert secret_example.is_file(), f"required example is missing: {secret_example}"

    generated = set(required_keys.required_secret_keys(deployment.read_text()))
    example = yaml.safe_load(secret_example.read_text())
    documented = set(example.get("stringData", {})) | set(example.get("data", {}))
    assert generated == documented
