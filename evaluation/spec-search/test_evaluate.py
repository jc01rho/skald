import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
EVALUATOR = HERE / "evaluate.py"
SPEC = importlib.util.spec_from_file_location("spec_search_evaluate", EVALUATOR)
assert SPEC and SPEC.loader
EVALUATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EVALUATE)


def item(identifier, source, revision, evidence_ids=None):
    value = {
        "id": identifier,
        "project_id": "11111111-1111-4111-8111-111111111111",
        "source_id": source,
        "revision_id": revision,
    }
    if evidence_ids is not None:
        value["evidence_ids"] = evidence_ids
    return value


def golden_records():
    return [
        {
            "query_id": "related-1",
            "project_id": "11111111-1111-4111-8111-111111111111",
            "source_id": "query-related",
            "revision_id": "query-related-rev",
            "query": "related specs",
            "task": "related",
            "language": "other",
            "expected": [item("related-answer", "source-related", "rev-related")],
        },
        {
            "query_id": "conflict-1",
            "project_id": "11111111-1111-4111-8111-111111111111",
            "source_id": "query-conflict",
            "revision_id": "query-conflict-rev",
            "query": "conflicts",
            "task": "conflict",
            "language": "other",
            "expected": [
                item(
                    "conflict-answer",
                    "source-conflict",
                    "rev-conflict",
                    ["evidence-a", "evidence-b"],
                )
            ],
        },
        {
            "query_id": "phrase-ko-1",
            "project_id": "11111111-1111-4111-8111-111111111111",
            "source_id": "query-phrase",
            "revision_id": "query-phrase-rev",
            "query": "정확한 문구",
            "task": "phrase",
            "language": "ko",
            "expected": [item("phrase-answer", "source-phrase", "rev-phrase")],
        },
    ]


def result_record(golden, results):
    return {
        "query_id": golden["query_id"],
        "project_id": golden["project_id"],
        "source_id": golden["source_id"],
        "revision_id": golden["revision_id"],
        "results": results,
    }


class EvaluatorTests(unittest.TestCase):
    def run_evaluator(self, golden, results, *extra_args):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            golden_path = root / "golden.jsonl"
            results_path = root / "results.jsonl"
            golden_path.write_text(
                "".join(json.dumps(record) + "\n" for record in golden), encoding="utf-8"
            )
            results_path.write_text(
                "".join(json.dumps(record) + "\n" for record in results), encoding="utf-8"
            )
            completed = subprocess.run(
                [
                    sys.executable,
                    str(EVALUATOR),
                    "--golden",
                    str(golden_path),
                    "--results",
                    str(results_path),
                    "--query-manifest",
                    str(golden_path),
                    "--project-id",
                    "11111111-1111-4111-8111-111111111111",
                    "--scope-key",
                    "github:specs",
                    "--reconciliation-run-id",
                    "run-2",
                    "--dataset",
                    "golden-spec-capabilities",
                    "--dataset-version",
                    "2026-07-30.1",
                    "--owner",
                    "search-quality",
                    "--generated-at",
                    "2026-07-30T10:00:00Z",
                    "--reviewed-at",
                    "2026-07-30T11:00:00Z",
                    *extra_args,
                ],
                check=False,
                capture_output=True,
                text=True,
            )
        self.assertEqual(completed.stderr, "")
        return completed.returncode, json.loads(completed.stdout)

    def test_passing_dataset_outputs_all_metrics(self):
        golden = golden_records()
        results = [
            result_record(golden[0], golden[0]["expected"]),
            result_record(golden[1], golden[1]["expected"]),
            result_record(golden[2], golden[2]["expected"]),
        ]

        code, report = self.run_evaluator(golden, results)

        self.assertEqual(code, 0)
        self.assertEqual(report["status"], "completed")
        self.assertTrue(report["pass"])
        self.assertRegex(report["query_manifest_sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(
            set(report["metrics"]),
            {
                "related_recall_at_50",
                "conflict_recall_at_20",
                "conflict_precision_at_20",
                "conflict_false_positives_per_query_max",
                "evidence_validity",
                "phrase_recall_at_10",
                "korean_no_result",
            },
        )
        payload = {key: value for key, value in report.items() if key != "artifact_sha256"}
        self.assertEqual(report["artifact_sha256"], EVALUATE.canonical_artifact_sha256(payload))
        self.assertTrue(all(check["passed"] for check in report["checks"].values()))

    def test_false_positive_gate_uses_worst_conflict_query(self):
        golden = golden_records()
        second = {
            **golden[1],
            "query_id": "conflict-2",
            "source_id": "query-conflict-2",
            "revision_id": "query-conflict-rev-2",
        }
        golden.append(second)
        noisy = [item(f"noise-{index}", f"source-noise-{index}", f"rev-noise-{index}", [f"e-{index}"]) for index in range(11)]
        results = [
            result_record(golden[0], golden[0]["expected"]),
            result_record(golden[1], [*golden[1]["expected"], *noisy]),
            result_record(golden[2], golden[2]["expected"]),
            result_record(second, second["expected"]),
        ]
        code, report = self.run_evaluator(golden, results)
        self.assertEqual(code, 1)
        self.assertEqual(report["metrics"]["conflict_false_positives_per_query_max"], 11.0)
        self.assertFalse(report["checks"]["conflict_false_positives_per_query_max"]["passed"])

    def test_threshold_failure_is_nonzero_and_reports_failed_checks(self):
        golden = golden_records()
        false_conflict = item(
            "wrong-conflict", "source-wrong", "rev-wrong", ["evidence-wrong"]
        )
        results = [
            result_record(golden[0], []),
            result_record(golden[1], [false_conflict]),
            result_record(golden[2], []),
        ]

        code, report = self.run_evaluator(golden, results)

        self.assertEqual(code, 1)
        self.assertFalse(report["pass"])
        self.assertFalse(report["checks"]["related_recall_at_50"]["passed"])
        self.assertFalse(report["checks"]["conflict_precision_at_20"]["passed"])
        self.assertFalse(report["checks"]["phrase_recall_at_10"]["passed"])
        self.assertFalse(report["checks"]["korean_no_result"]["passed"])

    def test_thresholds_are_fixed_and_cannot_be_overridden(self):
        golden = golden_records()
        results = [
            result_record(golden[0], []),
            result_record(golden[1], []),
            result_record(golden[2], []),
        ]
        code, report = self.run_evaluator(golden, results)
        self.assertEqual(code, 1)
        self.assertEqual(report["thresholds"], EVALUATE.FIXED_THRESHOLDS)
        self.assertFalse(report["pass"])

    def test_invalid_evidence_on_matched_conflict_fails_validity_gate(self):
        golden = golden_records()
        invalid = item(
            "conflict-answer", "source-conflict", "rev-conflict", ["evidence-a"]
        )
        results = [
            result_record(golden[0], golden[0]["expected"]),
            result_record(golden[1], [invalid]),
            result_record(golden[2], golden[2]["expected"]),
        ]

        code, report = self.run_evaluator(golden, results)

        self.assertEqual(code, 1)
        self.assertEqual(report["metrics"]["evidence_validity"], 0.0)
        self.assertFalse(report["checks"]["evidence_validity"]["passed"])

    def test_malformed_revision_pin_fails_nonzero(self):
        golden = golden_records()
        results = [
            result_record(golden[0], golden[0]["expected"]),
            result_record(golden[1], golden[1]["expected"]),
            result_record(golden[2], golden[2]["expected"]),
        ]
        results[0]["revision_id"] = "different-query-revision"

        code, report = self.run_evaluator(golden, results)

        self.assertEqual(code, 2)
        self.assertEqual(report["status"], "error")
        self.assertIn("revision pin", report["error"])

    def test_cross_project_result_fails_nonzero(self):
        golden = golden_records()
        cross_project = dict(golden[0]["expected"][0], project_id="other-project")
        results = [
            result_record(golden[0], [cross_project]),
            result_record(golden[1], golden[1]["expected"]),
            result_record(golden[2], golden[2]["expected"]),
        ]

        code, report = self.run_evaluator(golden, results)

        self.assertEqual(code, 2)
        self.assertIn("another project", report["error"])

    def test_empty_dataset_fails_nonzero(self):
        code, report = self.run_evaluator([], [])

        self.assertEqual(code, 2)
        self.assertEqual(report["status"], "error")
        self.assertIn("at least one JSON record", report["error"])

    def test_invalid_json_fails_nonzero(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            golden_path = root / "golden.jsonl"
            results_path = root / "results.jsonl"
            golden_path.write_text("{bad json}\n", encoding="utf-8")
            results_path.write_text("{}\n", encoding="utf-8")
            completed = subprocess.run(
                [
                    sys.executable,
                    str(EVALUATOR),
                    "--golden", str(golden_path),
                    "--results", str(results_path),
                    "--query-manifest", str(golden_path),
                    "--project-id", "11111111-1111-4111-8111-111111111111",
                    "--scope-key", "github:specs",
                    "--reconciliation-run-id", "run-2",
                    "--dataset", "golden-spec-capabilities",
                    "--dataset-version", "2026-07-30.1",
                    "--owner", "search-quality",
                    "--generated-at", "2026-07-30T10:00:00Z",
                    "--reviewed-at", "2026-07-30T11:00:00Z",
                ],
                check=False,
                capture_output=True,
                text=True,
            )

        self.assertEqual(completed.returncode, 2)
        report = json.loads(completed.stdout)
        self.assertEqual(report["status"], "error")
        self.assertIn("invalid JSON", report["error"])


if __name__ == "__main__":
    unittest.main()
