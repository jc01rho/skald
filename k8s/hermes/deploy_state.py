#!/usr/bin/env python3
"""Failure-atomic Kubernetes orchestration for the retained Discord owners.

The durable owner ConfigMap, not workload existence, selects the owner. Every
mutation is bounded and read back. An indeterminate result writes no Kubernetes
state itself, leaves the precreated operation Lease held, and terminates with
RECOVERY_REQUIRED (exit 75).
"""
from __future__ import annotations

import argparse
import importlib.util
import base64
import copy
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import stat
import time
import uuid
import yaml
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

NAMESPACE = os.environ.get("NAMESPACE", "skald")
LEASE = "skald-discord-deploy-operation"
OWNER_CONFIGMAP = "skald-discord-owner-state"
OWNER_KEY = "owner.json"
LEGACY_DEPLOYMENT = "discord-bot"
HERMES_DEPLOYMENT = "hermes-gateway"
REQUEST_TIMEOUT = int(os.environ.get("HERMES_KUBECTL_TIMEOUT_SECONDS", "30"))
WAIT_SECONDS = int(os.environ.get("HERMES_LEASE_WAIT_SECONDS", "0"))
ROOT = Path(__file__).resolve().parents[2]
K8S = ROOT / "k8s"
SNAPSHOT_CODEC_PATH = ROOT / "hermes-runtime" / "tools" / "snapshot_codec.py"
SNAPSHOT_CODEC_SPEC = importlib.util.spec_from_file_location("skald_snapshot_codec", SNAPSHOT_CODEC_PATH)
if SNAPSHOT_CODEC_SPEC is None or SNAPSHOT_CODEC_SPEC.loader is None:
    raise RuntimeError(f"Unable to load snapshot codec: {SNAPSHOT_CODEC_PATH}")
SNAPSHOT_CODEC = importlib.util.module_from_spec(SNAPSHOT_CODEC_SPEC)
SNAPSHOT_CODEC_SPEC.loader.exec_module(SNAPSHOT_CODEC)
DIGEST_RE = re.compile(r"^[a-z0-9./:_-]+@sha256:[0-9a-f]{64}$")
ACTOR = os.environ.get("HERMES_OPERATION_ACTOR") or f"{os.uname().nodename}:{os.getpid()}:{uuid.uuid4()}"
REQUIRED_IDENTITY = os.environ.get("HERMES_DEPLOY_IDENTITY", "")
IDENTITY_VERIFIED = False

# RBAC cannot restrict create by resourceName. Snapshot ConfigMaps are content-
# addressed, so ConfigMap create/get are resource-scoped; other checks are named.
OPERATOR_PERMISSIONS = (
    ("get", "leases.coordination.k8s.io", LEASE),
    ("update", "leases.coordination.k8s.io", LEASE),
    ("get", "deployments.apps", LEGACY_DEPLOYMENT),
    ("patch", "deployments.apps", LEGACY_DEPLOYMENT),
    ("watch", "deployments.apps", LEGACY_DEPLOYMENT),
    ("get", "deployments.apps", HERMES_DEPLOYMENT),
    ("patch", "deployments.apps", HERMES_DEPLOYMENT),
    ("watch", "deployments.apps", HERMES_DEPLOYMENT),
    ("create", "deployments.apps", None),
    ("get", "configmaps", None),
    ("create", "configmaps", None),
    ("update", "configmaps", OWNER_CONFIGMAP),
    ("patch", "configmaps", "discord-bot-config"),
    ("patch", "configmaps", "hermes-gateway-config"),
    ("get", "secrets", "discord-bot-secrets"),
    ("get", "secrets", "hermes-gateway-secrets"),
    ("get", "services", "discord-bot-service"),
    ("create", "services", None),
    ("patch", "services", "discord-bot-service"),
    ("get", "services/proxy", "http:discord-bot-service:3000"),
)
# These grants are incompatible with an ordinary transition identity even when
# it also has every required grant above. None is used by this orchestrator.
PROHIBITED_PERMISSIONS = (
    ("create", "leases.coordination.k8s.io", None),
    ("delete", "leases.coordination.k8s.io", LEASE),
    ("delete", "configmaps", OWNER_CONFIGMAP),
    ("delete", "configmaps", None),  # includes content-addressed snapshots
    ("deletecollection", "configmaps", None),
    ("deletecollection", "secrets", None),
    ("deletecollection", "deployments.apps", None),
    ("deletecollection", "pods", None),
    ("bind", "roles.rbac.authorization.k8s.io", None),
    ("bind", "clusterroles.rbac.authorization.k8s.io", None),
    ("escalate", "roles.rbac.authorization.k8s.io", None),
    ("escalate", "clusterroles.rbac.authorization.k8s.io", None),
    ("impersonate", "users", None),
    ("impersonate", "groups", None),
    ("impersonate", "serviceaccounts", None),
    ("impersonate", "uids.authentication.k8s.io", None),
    ("impersonate", "userextras.authentication.k8s.io", None),
    ("*", "*", None),
    ("get", "*", None),
    ("list", "*", None),
    ("watch", "*", None),
    ("create", "*", None),
    ("update", "*", None),
    ("patch", "*", None),
    ("delete", "*", None),
    ("deletecollection", "*", None),
    ("bind", "*", None),
    ("escalate", "*", None),
    ("impersonate", "*", None),
    ("*", "leases.coordination.k8s.io", None),
    ("*", "deployments.apps", None),
    ("*", "configmaps", None),
    ("*", "secrets", None),
    ("*", "services", None),
    ("*", "services/proxy", None),
    ("*", "pods", None),
    ("*", "roles.rbac.authorization.k8s.io", None),
    ("*", "clusterroles.rbac.authorization.k8s.io", None),
    ("*", "users", None),
    ("*", "groups", None),
    ("*", "serviceaccounts", None),
)
MUTATIONS_ALLOWED = True
DESTRUCTIVE_BOUNDARY_CROSSED = False
RECOVERY_EVIDENCE_MAX_AGE_SECONDS = 900


class Exit(Exception):
    def __init__(self, code: int, message: str):
        self.code, self.message = code, message


class Conflict(Exception):
    pass


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def log(event: str, **fields: Any) -> None:
    safe = " ".join(f"{key}={str(value).replace(chr(10), '_')}" for key, value in sorted(fields.items()))
    print(f"hermes_deploy event={event}{(' ' + safe) if safe else ''}", file=sys.stderr)

def operator_identity_matches(whoami: dict[str, Any]) -> bool:
    user_info = whoami.get("status", {}).get("userInfo", {})
    if REQUIRED_IDENTITY.startswith("user:"):
        return bool(REQUIRED_IDENTITY[5:]) and user_info.get("username") == REQUIRED_IDENTITY[5:]
    if REQUIRED_IDENTITY.startswith("group:"):
        groups = user_info.get("groups", [])
        return bool(REQUIRED_IDENTITY[6:]) and isinstance(groups, list) and REQUIRED_IDENTITY[6:] in groups
    return False


def read_current_identity(base: list[str]) -> dict[str, Any] | None:
    try:
        result = subprocess.run([*base, "auth", "whoami", "-o", "json"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=REQUEST_TIMEOUT + 5)
        return json.loads(result.stdout) if result.returncode == 0 else None
    except (subprocess.TimeoutExpired, OSError, ValueError, UnicodeDecodeError):
        return None



def permission_allowed(base: list[str], verb: str, resource: str, name: str | None) -> bool:
    if "/" in resource and name is not None:
        base_resource, subresource = resource.split("/", 1)
        command = [*base, "auth", "can-i", verb, f"{base_resource}/{name}", "--subresource", subresource, "-n", NAMESPACE]
    else:
        target = f"{resource}/{name}" if name is not None else resource
        command = [*base, "auth", "can-i", verb, target, "-n", NAMESPACE]
    try:
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=REQUEST_TIMEOUT + 5)
    except (subprocess.TimeoutExpired, OSError):
        raise Exit(77, f"Kubernetes permission preflight failed for {verb} {resource}/{name or '*'}")
    answer = result.stdout.strip().lower()
    if answer not in (b"yes", b"no"):
        raise Exit(77, f"Kubernetes permission preflight was inconclusive for {verb} {resource}/{name or '*'}")
    if result.returncode not in (0, 1):
        raise Exit(77, f"Kubernetes permission preflight failed for {verb} {resource}/{name or '*'}")
    return answer == b"yes"

def current_snapshot_names(base: list[str]) -> tuple[str, ...]:
    command = [*base, "get", "configmap", OWNER_CONFIGMAP, "-n", NAMESPACE, "-o", "json"]
    try:
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=REQUEST_TIMEOUT + 5)
    except (subprocess.TimeoutExpired, OSError):
        raise Exit(77, "Kubernetes authority permission preflight failed")
    if result.returncode:
        if b"NotFound" in result.stderr:
            return ()
        raise Exit(77, "Kubernetes authority permission preflight was inconclusive")
    try:
        owner = json.loads(result.stdout)
        record = json.loads(owner.get("data", {}).get(OWNER_KEY))
    except (AttributeError, TypeError, ValueError, UnicodeDecodeError):
        raise Exit(77, "Kubernetes authority permission preflight found an invalid owner record")
    names = []
    for key in ("legacy_snapshot_ref", "hermes_verified_snapshot_ref"):
        ref = record.get(key)
        if ref is not None:
            if not isinstance(ref, str) or not ref.startswith(f"configmap://{NAMESPACE}/"):
                raise Exit(77, "Kubernetes authority permission preflight found an invalid snapshot reference")
            names.append(ref.rsplit("/", 1)[1])
    return tuple(names)




def verify_operator_identity() -> None:
    global IDENTITY_VERIFIED
    if not REQUIRED_IDENTITY:
        raise Exit(64, "HERMES_DEPLOY_IDENTITY is required (user:<username> or group:<group>)")
    base = [os.environ.get("KUBECTL", "kubectl"), "--request-timeout", f"{REQUEST_TIMEOUT}s"]
    whoami = read_current_identity(base)
    if not isinstance(whoami, dict) or not operator_identity_matches(whoami):
        raise Exit(77, "Kubernetes identity does not match HERMES_DEPLOY_IDENTITY")
    for verb, resource, name in PROHIBITED_PERMISSIONS:
        if permission_allowed(base, verb, resource, name):
            raise Exit(77, f"Kubernetes identity has prohibited permission for {verb} {resource}/{name or '*'}")
    for verb, resource, name in OPERATOR_PERMISSIONS:
        if not permission_allowed(base, verb, resource, name):
            raise Exit(77, f"Kubernetes permission denied for {verb} {resource}/{name or '*'}")
    for name in current_snapshot_names(base):
        if permission_allowed(base, "delete", "configmaps", name):
            raise Exit(77, f"Kubernetes identity has prohibited permission for delete configmaps/{name}")
    IDENTITY_VERIFIED = True
    log("operator_identity_verified", required_identity=REQUIRED_IDENTITY)


def assert_current_identity() -> None:
    base = [os.environ.get("KUBECTL", "kubectl"), "--request-timeout", f"{REQUEST_TIMEOUT}s"]
    whoami = read_current_identity(base)
    if not isinstance(whoami, dict) or not operator_identity_matches(whoami):
        raise Exit(77, "Kubernetes identity changed after operator preflight")




def kubectl(args: list[str], *, stdin: bytes | None = None, mutation: bool = False, conclusive_codes: tuple[int, ...] = ()) -> subprocess.CompletedProcess[bytes]:
    global MUTATIONS_ALLOWED
    if not IDENTITY_VERIFIED:
        raise Exit(77, "Kubernetes operator identity was not verified")
    assert_current_identity()
    if mutation and not MUTATIONS_ALLOWED:
        raise Exit(75, "RECOVERY_REQUIRED: mutation attempted after indeterminate result")
    command = [os.environ.get("KUBECTL", "kubectl"), "--request-timeout", f"{REQUEST_TIMEOUT}s", *args]
    try:
        result = subprocess.run(command, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=REQUEST_TIMEOUT + 5)
    except (subprocess.TimeoutExpired, OSError):
        if mutation:
            MUTATIONS_ALLOWED = False
            raise Exit(75, "RECOVERY_REQUIRED: Kubernetes mutation response is unknown")
        raise Exit(65, f"Kubernetes read failed: {' '.join(args)}")
    if result.returncode and result.returncode not in conclusive_codes:
        stderr = result.stderr.decode("utf-8", "replace")
        if mutation and ("Conflict" in stderr or "object has been modified" in stderr):
            raise Conflict()
        if mutation:
            MUTATIONS_ALLOWED = False
            raise Exit(75, "RECOVERY_REQUIRED: Kubernetes mutation result is not conclusive")
        raise Exit(65, f"Kubernetes read failed: {' '.join(args)}")
    return result


def recovery_required(message: str) -> None:
    global MUTATIONS_ALLOWED
    MUTATIONS_ALLOWED = False
    raise Exit(75, f"RECOVERY_REQUIRED: {message}")


def mark_destructive_boundary() -> None:
    global DESTRUCTIVE_BOUNDARY_CROSSED
    DESTRUCTIVE_BOUNDARY_CROSSED = True


def parse_single_object(payload: str | bytes) -> dict[str, Any]:
    try:
        documents = list(yaml.safe_load_all(payload))
    except yaml.YAMLError:
        raise Exit(65, "Kubernetes manifest YAML is invalid")
    if len(documents) != 1 or not isinstance(documents[0], dict):
        raise Exit(65, "Kubernetes manifest must contain exactly one object")
    obj = documents[0]
    metadata = obj.get("metadata")
    if not isinstance(obj.get("apiVersion"), str) or not isinstance(obj.get("kind"), str) or not isinstance(metadata, dict) or not isinstance(metadata.get("name"), str):
        raise Exit(65, "Kubernetes manifest identity is invalid")
    return obj


def relevant_object(obj: dict[str, Any]) -> dict[str, Any]:
    relevant = copy.deepcopy(obj)
    relevant.pop("status", None)
    metadata = relevant.get("metadata", {})
    for key in ("creationTimestamp", "generation", "managedFields", "resourceVersion", "uid"):
        metadata.pop(key, None)
    annotations = metadata.get("annotations")
    if isinstance(annotations, dict):
        annotations.pop("kubectl.kubernetes.io/last-applied-configuration", None)
        if not annotations:
            metadata.pop("annotations", None)
    return relevant


def intended_fields_match(intended: Any, observed: Any) -> bool:
    if isinstance(intended, dict):
        return isinstance(observed, dict) and all(
            (field in observed and intended_fields_match(value, observed[field]))
            or (field not in observed and field in {"stdin", "tty"} and value is False)
            for field, value in intended.items()
        )
    if isinstance(intended, list):
        return isinstance(observed, list) and len(intended) == len(observed) and all(
            intended_fields_match(left, right) for left, right in zip(intended, observed)
        )
    return intended == observed


def readback_mutation(intended: dict[str, Any]) -> dict[str, Any]:
    kind = intended["kind"]
    name = intended["metadata"]["name"]
    try:
        current = get_json(kind, name)
    except Exit:
        recovery_required(f"mutation readback failed for {kind}/{name}")
    if current is None or not isinstance(current, dict) or not intended_fields_match(relevant_object(intended), relevant_object(current)):
        recovery_required(f"mutation readback differs for {kind}/{name}")
    return current


def get_json(kind: str, name: str, *, allow_missing: bool = False) -> dict[str, Any] | None:
    result = kubectl(["get", kind, name, "-n", NAMESPACE, "-o", "json"], conclusive_codes=(1,) if allow_missing else ())
    if result.returncode:
        if allow_missing and (b"NotFound" in result.stderr or b"not found" in result.stderr.lower()):
            return None
        raise Exit(65, f"Kubernetes read failed for {kind}/{name}")
    try:
        return json.loads(result.stdout)
    except (ValueError, UnicodeDecodeError):
        raise Exit(65, f"Invalid Kubernetes JSON for {kind}/{name}")


def holder(lease: dict[str, Any]) -> str:
    return str(lease.get("spec", {}).get("holderIdentity") or "")


def deployment_secret_keys(payload: str | bytes, expected_name: str) -> tuple[str, ...]:
    deployment = parse_single_object(payload)
    if deployment.get("kind") != "Deployment" or deployment.get("metadata", {}).get("name") != expected_name:
        raise Exit(65, "Snapshot deployment identity is invalid")
    pod_spec = deployment.get("spec", {}).get("template", {}).get("spec", {})
    keys: set[str] = set()
    for field in ("containers", "initContainers"):
        containers = pod_spec.get(field) or []
        if not isinstance(containers, list):
            raise Exit(65, f"Snapshot Deployment {field} are invalid")
        for container in containers:
            if not isinstance(container, dict):
                raise Exit(65, "Snapshot Deployment container is invalid")
            env_entries = container.get("env") or []
            if not isinstance(env_entries, list):
                raise Exit(65, "Snapshot Deployment environment is invalid")
            for env in env_entries:
                if not isinstance(env, dict):
                    raise Exit(65, "Snapshot Deployment environment is invalid")
                value_from = env.get("valueFrom")
                secret_ref = value_from.get("secretKeyRef") if isinstance(value_from, dict) else None
                if secret_ref is not None:
                    key = secret_ref.get("key") if isinstance(secret_ref, dict) else None
                    if not isinstance(key, str) or not key:
                        raise Exit(65, "Snapshot Deployment secret reference is invalid")
                    keys.add(key)
    if not keys:
        raise Exit(65, "Snapshot Deployment contains no Secret key references")
    return tuple(sorted(keys))


def exact_keys(value: Any, keys: set[str], message: str) -> None:
    if not isinstance(value, dict) or set(value) != keys:
        raise Exit(65, message)



def create_exact(obj: dict[str, Any]) -> dict[str, Any]:
    kubectl(["create", "-f", "-"], stdin=(canonical(obj) + "\n").encode(), mutation=True)
    return readback_mutation(obj)
def artifact_contract(record: dict[str, Any], data: dict[str, str], key: str, expected_name: str) -> None:
    descriptor = record[key]
    descriptor_keys = {"name", "data_key", "sha256"}
    if key == "deployment":
        descriptor_keys.add("replicas")
        if record.get("kind") == "hermes":
            descriptor_keys.update(("strategy", "argv"))
    exact_keys(descriptor, descriptor_keys, f"Snapshot {key} schema is invalid")
    data_key = descriptor["data_key"]
    if descriptor["name"] != expected_name or data_key != f"{key}.yaml" or not isinstance(data.get(data_key), str):
        raise Exit(65, f"Snapshot {key} binding is invalid")
    if descriptor["sha256"] != hashlib.sha256(data[data_key].encode()).hexdigest():
        raise Exit(65, f"Snapshot {key} artifact hash is invalid")


def replace_exact(obj: dict[str, Any], *, expected_kind: str, expected_name: str) -> dict[str, Any]:
    rv = obj.get("metadata", {}).get("resourceVersion")
    if not isinstance(rv, str) or not rv:
        raise Exit(65, "Missing exact resourceVersion CAS token")
    intended = copy.deepcopy(obj)
    try:
        kubectl(["replace", "-f", "-"], stdin=(canonical(obj) + "\n").encode(), mutation=True)
    except Conflict:
        raise
    except Exit:
        raise
    return readback_mutation(intended)


def acquire() -> dict[str, Any]:
    deadline = time.monotonic() + WAIT_SECONDS
    while True:
        lease = get_json("lease", LEASE)
        if lease is None:
            raise Exit(65, "Precreated operation Lease is required")
        current_holder = holder(lease)
        if current_holder:
            if time.monotonic() < deadline:
                time.sleep(1)
                continue
            raise Exit(73, f"Operation Lease is held; holder={current_holder}")
        desired = copy.deepcopy(lease)
        desired.setdefault("spec", {})["holderIdentity"] = ACTOR
        # No leaseDurationSeconds, acquireTime, renewTime, expiry, or takeover semantics.
        try:
            observed = replace_exact(desired, expected_kind="lease", expected_name=LEASE)
        except Conflict:
            continue
        if holder(observed) != ACTOR:
            recovery_required("acquisition readback is inconclusive")
        log("lease_acquired", actor=ACTOR, resource_version=observed["metadata"]["resourceVersion"])
        return observed


def assert_lease() -> dict[str, Any]:
    lease = get_json("lease", LEASE)
    if lease is None or holder(lease) != ACTOR:
        recovery_required("operation Lease ownership not conclusive")
    return lease


def release() -> None:
    lease = assert_lease()
    desired = copy.deepcopy(lease)
    desired.setdefault("spec", {})["holderIdentity"] = ""
    try:
        observed = replace_exact(desired, expected_kind="lease", expected_name=LEASE)
    except Conflict:
        recovery_required("operation Lease release conflicted")
    if holder(observed):
        recovery_required("operation Lease clear readback failed")
    log("lease_released", actor=ACTOR)


def load_owner(*, required: bool = True) -> tuple[dict[str, Any], dict[str, Any]] | None:
    obj = get_json("configmap", OWNER_CONFIGMAP, allow_missing=not required)
    if obj is None:
        if required:
            raise Exit(65, "Durable Discord owner record is missing")
        return None
    raw = obj.get("data", {}).get(OWNER_KEY)
    try:
        record = json.loads(raw)
    except (TypeError, ValueError):
        raise Exit(65, "Durable Discord owner record is invalid")
    exact = {"schema_version", "namespace", "active_owner", "generation", "legacy_snapshot_ref", "hermes_verified_snapshot_ref", "verified_at", "verified_by", "smoke"}
    if set(record) != exact or record.get("schema_version") != 1 or record.get("namespace") != NAMESPACE:
        raise Exit(65, "Durable Discord owner record schema/namespace mismatch")
    if record.get("active_owner") not in ("legacy", "hermes") or not isinstance(record.get("generation"), int) or record["generation"] < 1:
        raise Exit(65, "Durable Discord owner record state is invalid")
    if not valid_ref(record.get("legacy_snapshot_ref"), "skald-discord-legacy-"):
        raise Exit(65, "Legacy snapshot reference is invalid")
    if record["active_owner"] == "hermes" and not valid_ref(record.get("hermes_verified_snapshot_ref"), "skald-hermes-verified-"):
        raise Exit(65, "Hermes snapshot reference is invalid")
    validate_snapshot(record["legacy_snapshot_ref"], "legacy")
    if record.get("hermes_verified_snapshot_ref"):
        validate_snapshot(record["hermes_verified_snapshot_ref"], "hermes")
    return obj, record


def valid_ref(ref: Any, prefix: str) -> bool:
    return isinstance(ref, str) and ref.startswith(f"configmap://{NAMESPACE}/{prefix}") and re.fullmatch(rf"configmap://{re.escape(NAMESPACE)}/{prefix}[0-9a-f]{{16}}", ref) is not None


def ref_name(ref: str) -> str:
    return ref.rsplit("/", 1)[1]

def validate_snapshot(ref: str, kind: str) -> tuple[dict[str, Any], dict[str, str]]:
    obj = get_json("configmap", ref_name(ref))
    if obj is None or obj.get("immutable") is not True:
        raise Exit(65, "Snapshot is missing or mutable")
    data = obj.get("data") or {}
    expected_data = {"record.json", "deployment.yaml", "service.yaml", "configmap.yaml"} if kind == "legacy" else {"record.json", "deployment.yaml", "configmap.yaml"}
    if not isinstance(data, dict) or set(data) != expected_data or not all(isinstance(value, str) for value in data.values()):
        raise Exit(65, "Snapshot artifact schema is invalid")
    try:
        record = json.loads(data["record.json"])
        artifacts = {
            name: data[name].encode()
            for name in SNAPSHOT_CODEC.ENTRY_ORDER[kind]
            if name != "record.json"
        }
        digest = SNAPSHOT_CODEC.encode_snapshot(kind, record, artifacts)["snapshot_sha256"]
    except (KeyError, TypeError, ValueError):
        raise Exit(65, "Snapshot data is invalid")
    common = {"schema_version", "kind", "namespace", "captured_at", "image", "deployment", "configmap", "secret_ref", "smoke_profile", "snapshot_sha256"}
    expected_record = common | ({"service", "health"} if kind == "legacy" else set())
    exact_keys(record, expected_record, "Snapshot record schema is invalid")
    if record.get("schema_version") != 1 or record.get("kind") != kind or record.get("namespace") != NAMESPACE or record.get("snapshot_sha256") != digest or not obj.get("metadata", {}).get("name", "").endswith(digest[:16]):
        raise Exit(65, "Snapshot hash or binding is invalid")
    if not DIGEST_RE.fullmatch(record.get("image", "")):
        raise Exit(65, "Snapshot image is not immutable")
    deployment_expected = HERMES_DEPLOYMENT if kind == "hermes" else LEGACY_DEPLOYMENT
    artifact_contract(record, data, "configmap", "hermes-gateway-config" if kind == "hermes" else "discord-bot-config")
    artifact_contract(record, data, "deployment", deployment_expected)
    if record["deployment"].get("replicas") != 1:
        raise Exit(65, "Snapshot deployment replica contract is invalid")
    exact_keys(record["secret_ref"], {"name", "required_keys"}, "Snapshot Secret schema is invalid")
    expected_secret = "hermes-gateway-secrets" if kind == "hermes" else "discord-bot-secrets"
    if record["secret_ref"].get("name") != expected_secret or not isinstance(record["secret_ref"].get("required_keys"), list):
        raise Exit(65, "Snapshot Secret contract is invalid")
    if kind == "hermes" and record["secret_ref"]["required_keys"] != list(deployment_secret_keys(data["deployment.yaml"], deployment_expected)):
        raise Exit(65, "Snapshot Secret contract is invalid")
    if kind == "legacy" and record["secret_ref"]["required_keys"] != ["DISCORD_BOT_TOKEN"]:
        raise Exit(65, "Snapshot Secret contract is invalid")
    if kind == "hermes":
        exact_keys(record["deployment"], {"name", "data_key", "sha256", "replicas", "strategy", "argv"}, "Snapshot deployment schema is invalid")
        if record["deployment"].get("strategy") != "Recreate" or record["deployment"].get("argv") != ["hermes", "gateway", "run"]:
            raise Exit(65, "Hermes snapshot runtime contract is invalid")
    else:
        artifact_contract(record, data, "service", "discord-bot-service")
        exact_keys(record["health"], {"service", "path", "json_ready"}, "Snapshot health schema is invalid")
        if record["health"] != {"service": "discord-bot-service", "path": "/health", "json_ready": True}:
            raise Exit(65, "Snapshot health contract is invalid")
    return record, data


def mutate_scale(name: str, replicas: int) -> None:
    assert_lease()
    patch = canonical({"spec": {"replicas": replicas}}).encode()
    kubectl(["patch", "deployment", name, "-n", NAMESPACE, "--type=merge", "-p", patch.decode()], mutation=True)
    try:
        current = get_json("deployment", name, allow_missing=True)
    except Exit:
        recovery_required(f"scale readback failed for deployment/{name}")
    if current is None or current.get("spec", {}).get("replicas") != replicas:
        recovery_required(f"scale readback differs for deployment/{name}")


def apply_bytes(payload: str) -> None:
    assert_lease()
    intended = parse_single_object(payload)
    intended.setdefault("metadata", {}).setdefault("namespace", NAMESPACE)
    if intended["metadata"]["namespace"] != NAMESPACE:
        raise Exit(65, "Kubernetes manifest namespace mismatch")
    kubectl(["apply", "-f", "-", "-n", NAMESPACE], stdin=payload.encode(), mutation=True)
    readback_mutation(intended)

def restore_snapshot(ref: str, kind: str) -> None:
    _, data = validate_snapshot(ref, kind)
    inactive = HERMES_DEPLOYMENT if kind == "legacy" else LEGACY_DEPLOYMENT
    if get_json("deployment", inactive, allow_missing=True) is not None:
        mutate_scale(inactive, 0)
    for key in (("configmap.yaml", "service.yaml", "deployment.yaml") if kind == "legacy" else ("configmap.yaml", "deployment.yaml")):
        apply_bytes(data[key])
    wait_rollout(LEGACY_DEPLOYMENT if kind == "legacy" else HERMES_DEPLOYMENT)


def wait_rollout(name: str) -> None:
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        deployment = get_json("deployment", name)
        if deployment is None:
            raise Exit(65, f"Deployment/{name} is missing")
        desired = deployment.get("spec", {}).get("replicas", 0)
        status = deployment.get("status", {})
        generation = deployment.get("metadata", {}).get("generation")
        if (
            status.get("observedGeneration") == generation
            and status.get("updatedReplicas", 0) == desired
            and status.get("readyReplicas", 0) == desired
            and status.get("availableReplicas", 0) == desired
            and status.get("unavailableReplicas", 0) == 0
        ):
            return
        time.sleep(2)
    raise Exit(65, f"Deployment/{name} rollout timed out")


def smoke(owner: str) -> dict[str, str]:
    correlation = str(uuid.uuid4())
    profile = os.environ.get("LEGACY_SMOKE_PROFILE" if owner == "legacy" else "HERMES_SMOKE_PROFILE")
    if not profile:
        raise Exit(65, f"{owner} smoke profile is required")
    secret_name = "discord-bot-secrets" if owner == "legacy" else "hermes-gateway-secrets"
    secret = get_json("secret", secret_name)
    encoded = (secret or {}).get("data", {}).get("DISCORD_BOT_TOKEN")
    if not encoded:
        raise Exit(65, "Discord credential key is missing")
    try:
        token = base64.b64decode(encoded, validate=True)
    except ValueError:
        raise Exit(65, "Discord credential is malformed")
    result_dir = Path(tempfile.mkdtemp(prefix="skald-smoke-")); os.chmod(result_dir, 0o700)
    result_file = result_dir / "result.json"
    read_fd, write_fd = os.pipe()
    try:
        os.write(write_fd, token); os.close(write_fd); write_fd = -1
        command = [sys.executable, str(K8S / "hermes" / "smoke.py"), "--owner", owner, "--token-fd", str(read_fd), "--profile", profile, "--correlation-id", correlation, "--timeout-seconds", "180" if owner == "legacy" else "300", "--http-timeout-seconds", "10", "--poll-seconds", "2", "--result-file", str(result_file)]
        completed = subprocess.run(command, pass_fds=(read_fd,), timeout=330, env={**os.environ, "SMOKE_OWNER": owner, "SMOKE_CORRELATION_ID": correlation, "SMOKE_RESULT_FILE": str(result_file), "SMOKE_TOKEN_FD": str(read_fd)})
        if completed.returncode:
            raise Exit(completed.returncode, f"{owner} smoke failed with category code {completed.returncode}")
        result = json.loads(result_file.read_text())
        if result.get("status") != "success" or result.get("owner") != owner or result.get("correlation_id") != correlation:
            raise Exit(70, f"{owner} smoke result correlation failed")
        return {"profile": "legacy-mention" if owner == "legacy" else "hermes-functional-spec", "correlation_id": correlation, "completed_at": result["completed_at"]}
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError):
        raise Exit(71, f"{owner} smoke execution failed")
    finally:
        if write_fd >= 0: os.close(write_fd)
        os.close(read_fd)
        try: result_file.unlink()
        except FileNotFoundError: pass
        try: result_dir.rmdir()
        except OSError: pass


def publish_owner(owner_obj: dict[str, Any], previous: dict[str, Any], owner: str, snapshot_ref: str, smoke_result: dict[str, str], verified_by: str) -> dict[str, Any]:
    assert_lease()
    desired_record = dict(previous)
    desired_record.update({"active_owner": owner, "generation": previous["generation"] + 1, "verified_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"), "verified_by": verified_by, "smoke": smoke_result})
    if owner == "hermes": desired_record["hermes_verified_snapshot_ref"] = snapshot_ref
    desired = copy.deepcopy(owner_obj); desired.setdefault("data", {})[OWNER_KEY] = canonical(desired_record)
    try:
        observed = replace_exact(desired, expected_kind="configmap", expected_name=OWNER_CONFIGMAP)
    except Conflict:
        current_obj, current = load_owner(required=True)  # conclusive conflict: fresh durable authority only
        if canonical(current) != canonical(desired_record):
            restore_snapshot(current["legacy_snapshot_ref"] if current["active_owner"] == "legacy" else current["hermes_verified_snapshot_ref"], current["active_owner"])
            smoke(current["active_owner"])
            raise Exit(73, "Owner index conflict reconciled to current durable owner")
        observed = current_obj
    if observed.get("data", {}).get(OWNER_KEY) != canonical(desired_record):
        recovery_required("owner publication readback failed")
    return desired_record


def render_hermes() -> str:
    image = os.environ.get("HERMES_IMAGE", "")
    if not DIGEST_RE.fullmatch(image):
        raise Exit(64, "HERMES_IMAGE must be a full immutable image digest independent of IMAGE_TAG")
    source = (K8S / "hermes-gateway-deployment.yaml").read_text()
    rendered = source.replace("${HERMES_IMAGE}", image).replace("image: HERMES_IMAGE", f"image: {image}")
    if "${HERMES_IMAGE}" in rendered or "image: HERMES_IMAGE" in rendered:
        raise Exit(65, "Hermes image rendering failed")
    return rendered


def hermes_configmap_yaml() -> str:
    configured = os.environ.get("HERMES_CONFIGMAP_FILE")
    config_path = Path(configured) if configured else K8S / "hermes-gateway-configmap.local.yaml"
    if str(config_path).endswith(".example"):
        raise Exit(64, "HERMES_CONFIGMAP_FILE must not reference an .example manifest")
    try:
        if not config_path.is_file():
            raise Exit(65, f"Hermes ConfigMap input is missing: {config_path}")
        return config_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise Exit(65, f"Hermes ConfigMap input is unreadable: {config_path}") from exc


def create_hermes_snapshot(deployment_yaml: str) -> str:
    config_yaml = hermes_configmap_yaml()
    image = os.environ["HERMES_IMAGE"]
    required_keys = list(deployment_secret_keys(deployment_yaml, HERMES_DEPLOYMENT))
    record = {"schema_version":1,"kind":"hermes","namespace":NAMESPACE,"captured_at":datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00","Z"),"image":image,"deployment":{"name":HERMES_DEPLOYMENT,"data_key":"deployment.yaml","sha256":hashlib.sha256(deployment_yaml.encode()).hexdigest(),"replicas":1,"strategy":"Recreate","argv":["hermes","gateway","run"]},"configmap":{"name":"hermes-gateway-config","data_key":"configmap.yaml","sha256":hashlib.sha256(config_yaml.encode()).hexdigest()},"secret_ref":{"name":"hermes-gateway-secrets","required_keys":required_keys},"smoke_profile":"hermes-functional-spec"}
    artifacts = {
        "deployment.yaml": deployment_yaml.encode(),
        "configmap.yaml": config_yaml.encode(),
    }
    encoded = SNAPSHOT_CODEC.encode_snapshot("hermes", record, artifacts)
    name = f"skald-hermes-verified-{encoded['name_suffix']}"
    data = {
        "deployment.yaml": deployment_yaml,
        "configmap.yaml": config_yaml,
        "record.json": encoded["record_json"].decode(),
    }
    manifest = {"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":name,"namespace":NAMESPACE,"labels":{"app.kubernetes.io/part-of":"skald","skald.io/discord-record":"true","skald.io/record-kind":"hermes","skald.io/namespace-binding":NAMESPACE}},"immutable":True,"data":data}
    assert_lease()
    existing = get_json("configmap", name, allow_missing=True)
    if existing is None:
        create_exact(manifest)
    validate_snapshot(f"configmap://{NAMESPACE}/{name}", "hermes")
    return f"configmap://{NAMESPACE}/{name}"


def hermes_preflight(rendered: str) -> str:
    if "type: Recreate" not in rendered or "command: ['hermes']" not in rendered or "args: ['gateway', 'run']" not in rendered:
        raise Exit(65, "Hermes manifest must preserve Recreate and exact hermes gateway run")
    config_yaml = hermes_configmap_yaml()
    secret = get_json("secret", "hermes-gateway-secrets")
    required = set(deployment_secret_keys(rendered, HERMES_DEPLOYMENT))
    present = set((secret or {}).get("data", {})) | set((secret or {}).get("stringData", {}))
    if not required or not required.issubset(present): raise Exit(65, "Hermes Secret required key names are missing")
    return config_yaml

def adopt_legacy() -> tuple[dict[str, Any], dict[str, Any]]:
    deployment = get_json("deployment", LEGACY_DEPLOYMENT)
    service = get_json("service", "discord-bot-service")
    configmap = get_json("configmap", "discord-bot-config")
    if deployment is None or service is None or configmap is None:
        raise Exit(65, "Legacy adoption resources are incomplete")
    containers = deployment.get("spec", {}).get("template", {}).get("spec", {}).get("containers") or []
    image = containers[0].get("image", "") if containers else ""
    hermes = get_json("deployment", HERMES_DEPLOYMENT, allow_missing=True)
    if deployment.get("spec", {}).get("replicas") != 1 or not DIGEST_RE.fullmatch(image) or (hermes and hermes.get("spec", {}).get("replicas", 0) != 0):
        raise Exit(65, "Legacy adoption requires immutable legacy replicas=1 and Hermes replicas=0")
    # The retained legacy Deployment is already proven ready by Kubernetes rollout.
    # Service proxy checks are intermittently unavailable through impersonated kubectl
    # on this cluster, so correlated Discord smoke remains the behavioral oracle.
    smoke_result = smoke("legacy")
    for obj in (deployment, service, configmap):
        obj.pop("status", None)
        for key in ("creationTimestamp", "generation", "managedFields", "resourceVersion", "uid"): obj.get("metadata", {}).pop(key, None)
    artifacts = {"deployment.yaml":canonical(deployment)+"\n", "service.yaml":canonical(service)+"\n", "configmap.yaml":canonical(configmap)+"\n"}
    record = {"schema_version":1,"kind":"legacy","namespace":NAMESPACE,"captured_at":datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00","Z"),"image":image,"deployment":{"name":LEGACY_DEPLOYMENT,"data_key":"deployment.yaml","sha256":hashlib.sha256(artifacts["deployment.yaml"].encode()).hexdigest(),"replicas":1},"service":{"name":"discord-bot-service","data_key":"service.yaml","sha256":hashlib.sha256(artifacts["service.yaml"].encode()).hexdigest()},"configmap":{"name":"discord-bot-config","data_key":"configmap.yaml","sha256":hashlib.sha256(artifacts["configmap.yaml"].encode()).hexdigest()},"secret_ref":{"name":"discord-bot-secrets","required_keys":["DISCORD_BOT_TOKEN"]},"health":{"service":"discord-bot-service","path":"/health","json_ready":True},"smoke_profile":"legacy-mention"}
    encoded = SNAPSHOT_CODEC.encode_snapshot(
        "legacy", record, {name: payload.encode() for name, payload in artifacts.items()}
    )
    name = f"skald-discord-legacy-{encoded['name_suffix']}"
    artifacts["record.json"] = encoded["record_json"].decode()
    snapshot = {"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":name,"namespace":NAMESPACE,"labels":{"app.kubernetes.io/part-of":"skald","skald.io/discord-record":"true","skald.io/record-kind":"legacy","skald.io/namespace-binding":NAMESPACE}},"immutable":True,"data":artifacts}
    create_exact(snapshot)
    ref = f"configmap://{NAMESPACE}/{name}"; validate_snapshot(ref, "legacy")
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00","Z")
    owner = {"schema_version":1,"namespace":NAMESPACE,"active_owner":"legacy","generation":1,"legacy_snapshot_ref":ref,"hermes_verified_snapshot_ref":None,"verified_at":now,"verified_by":"cutover-adopt","smoke":smoke_result}
    manifest = {"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":OWNER_CONFIGMAP,"namespace":NAMESPACE},"data":{OWNER_KEY:canonical(owner)}}
    create_exact(manifest)
    loaded = load_owner(required=True)
    if loaded is None or canonical(loaded[1]) != canonical(owner): recovery_required("initial owner readback failed")
    return loaded
def cutover(owner_obj: dict[str, Any], record: dict[str, Any]) -> None:
    if record["active_owner"] != "legacy": raise Exit(65, "cutover requires active_owner=legacy")
    rendered = render_hermes()
    config_yaml = hermes_preflight(rendered)
    smoke("legacy")  # preflight before stopping legacy
    previous_ref = record["legacy_snapshot_ref"]
    try:
        mark_destructive_boundary()
        mutate_scale(LEGACY_DEPLOYMENT, 0)
        apply_bytes(config_yaml)
        apply_bytes(rendered)
        wait_rollout(HERMES_DEPLOYMENT)
        result = smoke("hermes")
        snapshot = create_hermes_snapshot(rendered)
        publish_owner(owner_obj, record, "hermes", snapshot, result, "cutover")
    except Exit as failure:
        if failure.code == 75: raise
        restore_snapshot(previous_ref, "legacy")
        smoke("legacy")
        raise


def upgrade(owner_obj: dict[str, Any], record: dict[str, Any]) -> None:
    if record["active_owner"] != "hermes": raise Exit(65, "upgrade requires active_owner=hermes")
    previous_ref = record["hermes_verified_snapshot_ref"]
    rendered = render_hermes()
    config_yaml = hermes_preflight(rendered)
    try:
        mark_destructive_boundary()
        mutate_scale(LEGACY_DEPLOYMENT, 0) if get_json("deployment", LEGACY_DEPLOYMENT, allow_missing=True) else None
        apply_bytes(config_yaml); apply_bytes(rendered); wait_rollout(HERMES_DEPLOYMENT)
        result = smoke("hermes"); snapshot = create_hermes_snapshot(rendered)
        publish_owner(owner_obj, record, "hermes", snapshot, result, "upgrade")
    except Exit as failure:
        if failure.code == 75: raise
        restore_snapshot(previous_ref, "hermes"); smoke("hermes")
        raise


def rollback(owner_obj: dict[str, Any], record: dict[str, Any]) -> None:
    if record["active_owner"] == "legacy":
        smoke("legacy"); return
    mark_destructive_boundary()
    restore_snapshot(record["legacy_snapshot_ref"], "legacy")
    result = smoke("legacy")
    publish_owner(owner_obj, record, "legacy", record["legacy_snapshot_ref"], result, "rollback")


def dispatch(mode: str) -> str:
    if mode not in ("", "cutover", "upgrade", "rollback"):
        raise Exit(64, "HERMES_DEPLOY_MODE must be unset, cutover, upgrade, or rollback")
    preflight_owner = load_owner(required=mode != "cutover")
    if not mode:
        assert preflight_owner is not None
        _, record = preflight_owner
        return "legacy" if record["active_owner"] == "legacy" else "skip"
    if mode in ("cutover", "upgrade"):
        hermes_configmap_yaml()
    acquire()
    assert_lease()
    try:
        locked_owner = load_owner(required=False)
        if locked_owner is None:
            if mode != "cutover":
                raise Exit(65, "Durable Discord owner record is missing")
            owner_obj, record = adopt_legacy()
        else:
            owner_obj, record = locked_owner
        if mode == "cutover": cutover(owner_obj, record)
        elif mode == "upgrade": upgrade(owner_obj, record)
        else: rollback(owner_obj, record)
        # Final equivalence: active one, inactive zero, and owner smoke before clear.
        _, final = load_owner(required=True)
        inactive = HERMES_DEPLOYMENT if final["active_owner"] == "legacy" else LEGACY_DEPLOYMENT
        inactive_obj = get_json("deployment", inactive, allow_missing=True)
        if inactive_obj and inactive_obj.get("spec", {}).get("replicas", 0) != 0:
            recovery_required("inactive owner is not scale zero")
        smoke(final["active_owner"])
        release()
        return "managed"
    except BaseException:
        error = sys.exc_info()[1]
        if DESTRUCTIVE_BOUNDARY_CROSSED:
            if isinstance(error, Exit) and error.code == 75:
                raise
            recovery_required("operation failed after destructive boundary")
        if isinstance(error, Exit) and error.code != 75 and MUTATIONS_ALLOWED:
            release()
        raise



def retained_undeploy() -> None:
    load_owner(required=True)  # non-authoritative preflight before waiting on the Lease
    acquire()
    try:
        assert_lease()
        _, record = load_owner(required=True)
        inactive = HERMES_DEPLOYMENT if record["active_owner"] == "legacy" else LEGACY_DEPLOYMENT
        if get_json("deployment", inactive, allow_missing=True):
            mark_destructive_boundary()
            mutate_scale(inactive, 0)
        smoke(record["active_owner"])
        release()
        log("discord_retention", action="preserve", active_owner=record["active_owner"])
    except BaseException:
        error = sys.exc_info()[1]
        if DESTRUCTIVE_BOUNDARY_CROSSED:
            if isinstance(error, Exit) and error.code == 75:
                raise
            recovery_required("retained undeploy failed after destructive boundary")
        if isinstance(error, Exit) and error.code != 75 and MUTATIONS_ALLOWED:
            release()
        raise


def recover(args: argparse.Namespace) -> None:
    global ACTOR
    evidence_path = Path(args.evidence_file)
    try:
        evidence_stat = evidence_path.stat()
        if not stat.S_ISREG(evidence_stat.st_mode) or stat.S_IMODE(evidence_stat.st_mode) != 0o600:
            raise Exit(64, "Recovery evidence file must be a mode 0600 regular file")
        evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    except Exit:
        raise
    except (OSError, ValueError):
        raise Exit(64, "Recovery evidence file must be readable JSON")
    exact_keys(evidence, {"schema_version", "incident", "holder", "actor", "request", "approver", "owner_snapshot"}, "Recovery evidence schema is invalid")
    exact_keys(evidence.get("request"), {"request_id", "requested_at", "process_quiescence_proof", "request_quiescence_proof"}, "Recovery request evidence schema is invalid")
    if evidence.get("schema_version") != 1 or not all(isinstance(evidence.get(key), str) and evidence[key] for key in ("incident", "holder", "actor", "approver")):
        raise Exit(64, "Recovery evidence identity fields are invalid")
    if evidence["actor"] != ACTOR:
        raise Exit(65, "Recovery actor evidence does not match")
    if not all(isinstance(evidence["request"].get(key), str) and evidence["request"][key] for key in ("request_id", "requested_at", "process_quiescence_proof", "request_quiescence_proof")):
        raise Exit(64, "Recovery request evidence is incomplete")
    try:
        requested_at = datetime.fromisoformat(evidence["request"]["requested_at"].replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - requested_at.astimezone(timezone.utc)).total_seconds()
    except ValueError:
        raise Exit(64, "Recovery request timestamp is invalid")
    if age < 0 or age > RECOVERY_EVIDENCE_MAX_AGE_SECONDS:
        raise Exit(65, "Recovery request evidence is stale")
    lease = get_json("lease", LEASE)
    if lease is None or holder(lease) != evidence["holder"] or not holder(lease):
        raise Exit(65, "Recovery holder evidence does not match")
    _, record = load_owner(required=True)
    if not isinstance(evidence.get("owner_snapshot"), dict) or canonical(evidence["owner_snapshot"]) != canonical(record):
        raise Exit(65, "Recovery owner snapshot evidence does not match")
    audit_path = Path(args.audit_file)
    try:
        audit_path.write_text(canonical({**evidence, "status":"recovery-started"})+"\n", encoding="utf-8")
        os.chmod(audit_path, 0o600)
    except OSError:
        raise Exit(65, "Recovery audit file is not writable")
    target = record["legacy_snapshot_ref"] if record["active_owner"] == "legacy" else record["hermes_verified_snapshot_ref"]
    # Recovery authorization remains attributed to evidence["actor"], while all
    # Kubernetes mutations are fenced by the already-held Lease identity.
    ACTOR = evidence["holder"]
    mark_destructive_boundary()
    try:
        restore_snapshot(target, record["active_owner"])
        smoke_result = smoke(record["active_owner"])
        audit = {**evidence, "smoke":smoke_result, "completed_at":datetime.now(timezone.utc).isoformat()}
        try:
            audit_path.write_text(canonical(audit)+"\n", encoding="utf-8")
            os.chmod(audit_path, 0o600)
        except OSError:
            recovery_required("recovery audit finalization failed")
        release()
    except BaseException:
        error = sys.exc_info()[1]
        if isinstance(error, Exit) and error.code == 75:
            raise
        detail = error.message if isinstance(error, Exit) else type(error).__name__
        recovery_required(f"recovery operation failed after destructive boundary: {detail}")


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    deploy = sub.add_parser("dispatch"); deploy.add_argument("--mode", default=os.environ.get("HERMES_DEPLOY_MODE", ""))
    sub.add_parser("retained-undeploy")
    recovery = sub.add_parser("recover")
    recovery.add_argument("--evidence-file", required=True)
    recovery.add_argument("--audit-file", required=True)
    args = parser.parse_args()
    verify_operator_identity()
    if args.command == "dispatch": print(dispatch(args.mode))
    elif args.command == "retained-undeploy": retained_undeploy()
    else: recover(args)
    return 0


if __name__ == "__main__":
    try: raise SystemExit(main())
    except Exit as exc:
        log("failure", code=exc.code, message=exc.message)
        raise SystemExit(exc.code)
