from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]
DEPLOYMENT_PATH = ROOT / "k8s" / "worker-deployment.yaml"
CONFIGMAP_PATH = ROOT / "k8s" / "worker-configmap.yaml"
STATE_DIRECTORY = "/var/lib/skald-worker"
STATE_FILE = f"{STATE_DIRECTORY}/sync-state.json"


def load_documents(path):
    return [document for document in yaml.safe_load_all(path.read_text()) if document]


def test_worker_sync_state_uses_durable_pvc_without_secret_changes():
    documents = load_documents(DEPLOYMENT_PATH)
    pvc = next(document for document in documents if document["kind"] == "PersistentVolumeClaim")
    deployment = next(document for document in documents if document["kind"] == "Deployment")

    assert pvc["metadata"]["name"] == "skald-worker-state"
    assert pvc["spec"]["accessModes"] == ["ReadWriteOnce"]

    assert deployment["spec"]["replicas"] == 1
    assert deployment["spec"]["strategy"] == {"type": "Recreate"}
    pod_spec = deployment["spec"]["template"]["spec"]
    container = pod_spec["containers"][0]
    assert {"name": "sync-state", "mountPath": STATE_DIRECTORY} in container["volumeMounts"]
    assert {
        "name": "sync-state",
        "persistentVolumeClaim": {"claimName": "skald-worker-state"},
    } in pod_spec["volumes"]
    assert pod_spec["securityContext"]["runAsUser"] == 1000
    assert pod_spec["securityContext"]["fsGroup"] == 1000
    assert pod_spec["securityContext"]["fsGroupChangePolicy"] == "OnRootMismatch"
    assert container["envFrom"] == [
        {"configMapRef": {"name": "skald-worker-config", "optional": False}},
        {"secretRef": {"name": "skald-worker-secrets"}},
    ]
    assert container["startupProbe"] == {
        "httpGet": {"path": "/health", "port": "http"},
        "periodSeconds": 10,
        "timeoutSeconds": 5,
        "failureThreshold": 180,
    }


def test_worker_config_points_state_at_mounted_durable_path():
    configmap = load_documents(CONFIGMAP_PATH)[0]

    assert configmap["data"]["SYNC_STATE_FILE"] == STATE_FILE
    assert not configmap["data"]["SYNC_STATE_FILE"].startswith("/tmp/")
