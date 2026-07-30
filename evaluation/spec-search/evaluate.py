#!/usr/bin/env python3
"""Evaluate revision-pinned spec-search golden data against ranked results."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


TASKS = {"related", "conflict", "phrase"}
LANGUAGES = {"ko", "other"}
FIXED_THRESHOLDS = {
    "related_recall_at_50": 0.95,
    "conflict_recall_at_20": 0.90,
    "conflict_precision_at_20": 0.80,
    "conflict_false_positives_per_query_max": 10,
    "evidence_validity": 1.0,
    "phrase_recall_at_10": 0.95,
    "korean_no_result": True,
}


class EvaluationError(ValueError):
    pass


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise EvaluationError(f"invalid arguments: {message}")


def require_object(value: Any, context: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise EvaluationError(f"{context} must be a JSON object")
    return value


def require_id(record: dict[str, Any], field: str, context: str) -> str:
    value = record.get(field)
    if not isinstance(value, str) or not value.strip():
        raise EvaluationError(f"{context}.{field} must be a non-empty string")
    if value != value.strip():
        raise EvaluationError(f"{context}.{field} must not have surrounding whitespace")
    return value


def require_string(record: dict[str, Any], field: str, context: str) -> str:
    return require_id(record, field, context)


def require_evidence_ids(
    record: dict[str, Any], context: str, *, nonempty: bool
) -> tuple[str, ...]:
    values = record.get("evidence_ids")
    if not isinstance(values, list):
        raise EvaluationError(f"{context}.evidence_ids must be an array")
    if nonempty and not values:
        raise EvaluationError(f"{context}.evidence_ids must not be empty")
    result: list[str] = []
    for index, value in enumerate(values):
        if not isinstance(value, str) or not value.strip() or value != value.strip():
            raise EvaluationError(
                f"{context}.evidence_ids[{index}] must be a non-empty trimmed string"
            )
        result.append(value)
    if len(result) != len(set(result)):
        raise EvaluationError(f"{context}.evidence_ids must not contain duplicates")
    return tuple(result)


def parse_item(value: Any, context: str, *, conflict: bool) -> dict[str, Any]:
    record = require_object(value, context)
    allowed = {"id", "project_id", "source_id", "revision_id", "evidence_ids"}
    unknown = sorted(set(record) - allowed)
    if unknown:
        raise EvaluationError(f"{context} has unknown fields: {', '.join(unknown)}")
    item = {
        "id": require_id(record, "id", context),
        "project_id": require_id(record, "project_id", context),
        "source_id": require_id(record, "source_id", context),
        "revision_id": require_id(record, "revision_id", context),
    }
    if conflict:
        item["evidence_ids"] = require_evidence_ids(record, context, nonempty=True)
    elif "evidence_ids" in record:
        raise EvaluationError(f"{context}.evidence_ids is only valid for conflict queries")
    return item


def item_key(item: dict[str, Any]) -> tuple[str, str, str, str]:
    return (
        item["id"],
        item["project_id"],
        item["source_id"],
        item["revision_id"],
    )


def read_jsonl(path: Path, label: str) -> list[tuple[int, dict[str, Any]]]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise EvaluationError(f"cannot read {label} file {path}: {exc}") from exc

    records: list[tuple[int, dict[str, Any]]] = []
    for line_number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise EvaluationError(
                f"{label} line {line_number} is invalid JSON: {exc.msg}"
            ) from exc
        records.append((line_number, require_object(value, f"{label} line {line_number}")))
    if not records:
        raise EvaluationError(f"{label} dataset must contain at least one JSON record")
    return records


def load_golden(path: Path) -> dict[str, dict[str, Any]]:
    golden: dict[str, dict[str, Any]] = {}
    for line_number, raw in read_jsonl(path, "golden"):
        context = f"golden line {line_number}"
        allowed = {
            "query_id",
            "project_id",
            "source_id",
            "revision_id",
            "query",
            "task",
            "language",
            "expected",
        }
        unknown = sorted(set(raw) - allowed)
        if unknown:
            raise EvaluationError(f"{context} has unknown fields: {', '.join(unknown)}")
        query_id = require_id(raw, "query_id", context)
        if query_id in golden:
            raise EvaluationError(f"duplicate golden query_id: {query_id}")
        task = raw.get("task")
        if task not in TASKS:
            raise EvaluationError(f"{context}.task must be one of: {', '.join(sorted(TASKS))}")
        language = raw.get("language")
        if language not in LANGUAGES:
            raise EvaluationError(
                f"{context}.language must be one of: {', '.join(sorted(LANGUAGES))}"
            )
        expected_raw = raw.get("expected")
        if not isinstance(expected_raw, list) or not expected_raw:
            raise EvaluationError(f"{context}.expected must be a non-empty array")
        expected = [
            parse_item(item, f"{context}.expected[{index}]", conflict=task == "conflict")
            for index, item in enumerate(expected_raw)
        ]
        expected_keys = [item_key(item) for item in expected]
        if len(expected_keys) != len(set(expected_keys)):
            raise EvaluationError(f"{context}.expected must not contain duplicate identities")
        project_id = require_id(raw, "project_id", context)
        if any(item["project_id"] != project_id for item in expected):
            raise EvaluationError(f"{context}.expected contains an item from another project")
        golden[query_id] = {
            "query_id": query_id,
            "project_id": project_id,
            "source_id": require_id(raw, "source_id", context),
            "revision_id": require_id(raw, "revision_id", context),
            "query": require_string(raw, "query", context),
            "task": task,
            "language": language,
            "expected": expected,
        }

    for task in TASKS:
        if not any(record["task"] == task for record in golden.values()):
            raise EvaluationError(f"golden dataset must contain at least one {task} query")
    if not any(record["language"] == "ko" for record in golden.values()):
        raise EvaluationError("golden dataset must contain at least one Korean query")
    return golden


def load_results(path: Path, golden: dict[str, dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    results: dict[str, list[dict[str, Any]]] = {}
    for line_number, raw in read_jsonl(path, "results"):
        context = f"results line {line_number}"
        allowed = {"query_id", "project_id", "source_id", "revision_id", "results"}
        unknown = sorted(set(raw) - allowed)
        if unknown:
            raise EvaluationError(f"{context} has unknown fields: {', '.join(unknown)}")
        query_id = require_id(raw, "query_id", context)
        if query_id in results:
            raise EvaluationError(f"duplicate results query_id: {query_id}")
        if query_id not in golden:
            raise EvaluationError(f"results contain unknown query_id: {query_id}")
        expected_query = golden[query_id]
        for field in ("project_id", "source_id", "revision_id"):
            value = require_id(raw, field, context)
            if value != expected_query[field]:
                raise EvaluationError(
                    f"{context}.{field} does not match the golden query revision pin"
                )
        ranked_raw = raw.get("results")
        if not isinstance(ranked_raw, list):
            raise EvaluationError(f"{context}.results must be an array")
        ranked = [
            parse_item(
                item,
                f"{context}.results[{index}]",
                conflict=expected_query["task"] == "conflict",
            )
            for index, item in enumerate(ranked_raw)
        ]
        keys = [item_key(item) for item in ranked]
        if len(keys) != len(set(keys)):
            raise EvaluationError(f"{context}.results must not contain duplicate identities")
        if any(item["project_id"] != expected_query["project_id"] for item in ranked):
            raise EvaluationError(f"{context}.results contains an item from another project")
        results[query_id] = ranked

    missing = sorted(set(golden) - set(results))
    if missing:
        raise EvaluationError(f"results are missing query_id values: {', '.join(missing)}")
    return results


def mean(values: list[float]) -> float:
    return sum(values) / len(values)


def recall_at(expected: list[dict[str, Any]], ranked: list[dict[str, Any]], limit: int) -> float:
    expected_keys = {item_key(item) for item in expected}
    returned_keys = {item_key(item) for item in ranked[:limit]}
    return len(expected_keys & returned_keys) / len(expected_keys)


def evaluate(
    golden: dict[str, dict[str, Any]], results: dict[str, list[dict[str, Any]]]
) -> dict[str, float]:
    related_recalls: list[float] = []
    conflict_recalls: list[float] = []
    conflict_precisions: list[float] = []
    conflict_false_positives: list[float] = []
    evidence_checks: list[float] = []
    phrase_recalls: list[float] = []
    korean_no_results: list[float] = []

    for query_id, query in golden.items():
        ranked = results[query_id]
        expected = query["expected"]
        if query["task"] == "related":
            related_recalls.append(recall_at(expected, ranked, 50))
        elif query["task"] == "phrase":
            phrase_recalls.append(recall_at(expected, ranked, 10))
        else:
            top = ranked[:20]
            expected_by_key = {item_key(item): item for item in expected}
            matched = [item for item in top if item_key(item) in expected_by_key]
            conflict_recalls.append(len(matched) / len(expected))
            conflict_precisions.append(len(matched) / len(top) if top else 0.0)
            conflict_false_positives.append(float(len(top) - len(matched)))
            for item in matched:
                approved = expected_by_key[item_key(item)]["evidence_ids"]
                evidence_checks.append(float(set(item["evidence_ids"]) == set(approved)))
        if query["language"] == "ko":
            korean_no_results.append(float(not ranked))

    korean_no_result_rate = mean(korean_no_results)
    return {
        "related_recall_at_50": mean(related_recalls),
        "conflict_recall_at_20": mean(conflict_recalls),
        "conflict_precision_at_20": mean(conflict_precisions),
        "conflict_false_positives_per_query_max": max(conflict_false_positives, default=0.0),
        "evidence_validity": mean(evidence_checks) if evidence_checks else 0.0,
        "phrase_recall_at_10": mean(phrase_recalls),
        "korean_no_result": korean_no_result_rate <= 0.05,
    }


def iso_datetime(value: str) -> str:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise argparse.ArgumentTypeError("must include a timezone")
    return parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(description=__doc__)
    parser.add_argument("--golden", required=True, type=Path, help="golden JSONL path")
    parser.add_argument("--results", required=True, type=Path, help="ranked results JSONL path")
    parser.add_argument("--query-manifest", required=True, type=Path, help="registered query manifest path")
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--scope-key", required=True)
    parser.add_argument("--reconciliation-run-id", required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--dataset-version", required=True)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--reviewed-at", required=True, type=iso_datetime)
    parser.add_argument("--generated-at", required=True, type=iso_datetime)
    return parser


def file_sha256(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as exc:
        raise EvaluationError(f"cannot read query manifest file {path}: {exc}") from exc


def canonical_value(value: Any) -> Any:
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [canonical_value(item) for item in value]
    if isinstance(value, dict):
        return {key: canonical_value(child) for key, child in value.items()}
    return value


def canonical_artifact_sha256(payload: dict[str, Any]) -> str:
    encoded = json.dumps(canonical_value(payload), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def run(argv: list[str] | None = None) -> tuple[dict[str, Any], int]:
    try:
        args = build_parser().parse_args(argv)
        golden = load_golden(args.golden)
        if any(query["project_id"] != args.project_id for query in golden.values()):
            raise EvaluationError("--project-id does not match every golden query")
        results = load_results(args.results, golden)
        metrics = evaluate(golden, results)
        checks: dict[str, dict[str, Any]] = {}
        for name, threshold in FIXED_THRESHOLDS.items():
            value = metrics[name]
            if name == "conflict_false_positives_per_query_max":
                operator = "<="
                passed = value <= threshold
            elif name == "korean_no_result":
                operator = "=="
                passed = value is threshold
            else:
                operator = ">="
                passed = value >= threshold
            checks[name] = {
                "value": value,
                "operator": operator,
                "threshold": threshold,
                "passed": passed,
            }
        passed = all(check["passed"] for check in checks.values())
        payload = {
            "schema_version": "1.0",
            "kind": "skald.spec-quality-readiness",
            "status": "completed",
            "pass": passed,
            "generated_at": args.generated_at,
            "reviewed_at": args.reviewed_at,
            "dataset": args.dataset,
            "version": args.dataset_version,
            "owner": args.owner,
            "project_id": args.project_id,
            "scope_key": args.scope_key,
            "reconciliation_run_id": args.reconciliation_run_id,
            "query_manifest_sha256": file_sha256(args.query_manifest),
            "thresholds": FIXED_THRESHOLDS,
            "metrics": metrics,
            "checks": checks,
        }
        report = {**payload, "artifact_sha256": canonical_artifact_sha256(payload)}
        return report, 0 if passed else 1
    except EvaluationError as exc:
        return {"status": "error", "error": str(exc)}, 2


def main() -> int:
    report, exit_code = run()
    json.dump(report, sys.stdout, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
