import re
from pathlib import Path

ROOT = Path(__file__).parents[2]
TRACKED_RUNTIME_FILES = [
    ROOT / "Dockerfile",
    ROOT / ".dockerignore",
    ROOT / "versions.lock",
    ROOT / "config" / "config.yaml.example",
    ROOT / "tools" / "generate_required_secret_keys.py",
    ROOT / "tools" / "snapshot_codec.py",
]


def test_runtime_sources_contain_names_but_no_credential_shaped_values():
    text = "\n".join(path.read_text() for path in TRACKED_RUNTIME_FILES)

    assert "secretKeyRef" in text
    assert not re.search(r"(?i)(token|api[_-]?key|password)\s*[:=]\s*['\"]?[A-Za-z0-9_-]{16,}", text)
    assert not re.search(r"sk_(?:proj|live|test)_[A-Za-z0-9]{16,}", text)
    assert not re.search(r"[MN][A-Za-z\d]{23,28}\.[\w-]{6}\.[\w-]{27,}", text)


def test_tools_never_read_secret_values_or_process_environment():
    tools = "\n".join(
        (ROOT / "tools" / name).read_text()
        for name in ("generate_required_secret_keys.py", "snapshot_codec.py")
    )
    assert "os.environ" not in tools
    assert "kubectl get secret" not in tools
    assert "secretKeyRef" in tools
