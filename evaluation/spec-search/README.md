# Spec-search golden dataset evaluator

`evaluate.py` compares an approved, revision-pinned golden JSONL file with a JSONL file of ranked candidates. It uses only the Python standard library, performs no network access, writes exactly one JSON report to stdout, and exits nonzero when input validation or a quality threshold fails.

`queries.example.jsonl` is a small synthetic schema example only. It contains no production labels or measured production scores and is not suitable for a readiness decision.

## Run

Python 3.9 or newer is required.

```bash
python3 evaluation/spec-search/evaluate.py \
  --golden /path/to/approved-golden.jsonl \
  --results /path/to/candidate-results.jsonl \
  --query-manifest /path/to/approved-golden.jsonl \
  --project-id 11111111-1111-4111-8111-111111111111 \
  --scope-key github:specs \
  --reconciliation-run-id run-20260730 \
  --dataset golden-spec-capabilities \
  --dataset-version 2026-07-30.1 \
  --owner search-quality \
  --generated-at 2026-07-30T10:00:00Z \
  --reviewed-at 2026-07-30T11:00:00Z
```

Readiness gates are fixed and cannot be overridden by CLI arguments:

- related Recall@50 >= 0.95
- conflict Recall@20 >= 0.90
- conflict Precision@20 >= 0.80
- maximum false positives on any conflict query <= 10
- evidence validity >= 1.00
- phrase Recall@10 >= 0.95
- Korean no-result rate <= 0.05, emitted as the boolean metric `korean_no_result`

The evaluator emits the exact strict readiness API artifact. `query_manifest_sha256` is computed from the bytes at `--query-manifest`; `generated_at` and `reviewed_at` are required explicit ISO-8601 timestamps from the evaluation and reviewer stages. `artifact_sha256` is SHA-256 over canonical sorted-key compact JSON of every other artifact field, including metrics and checks.

Exit codes:

- `0`: valid inputs and every threshold passed
- `1`: valid inputs but one or more thresholds failed
- `2`: malformed arguments or datasets

The program emits one compact JSON object even on failure, so readiness tooling can consume stdout deterministically. Diagnostics are in the report's `error` field rather than stderr.

## Golden JSONL schema

Each nonblank line is one object:

```json
{
  "query_id": "approved-query-id",
  "project_id": "project-id",
  "source_id": "query-source-id",
  "revision_id": "query-revision-id",
  "query": "query text",
  "task": "related",
  "language": "other",
  "expected": [
    {
      "id": "expected-result-id",
      "project_id": "project-id",
      "source_id": "expected-source-id",
      "revision_id": "expected-active-revision-id"
    }
  ]
}
```

Fields:

- `query_id`: unique stable query identifier.
- `project_id`, `source_id`, `revision_id`: non-empty IDs pinning the query and evaluation scope.
- `query`: non-empty query text.
- `task`: `related`, `conflict`, or `phrase`.
- `language`: `ko` for Korean queries or `other`.
- `expected`: non-empty approved result identities. Every expected result must belong to the query's project.

Conflict expected items additionally require `evidence_ids`, an array of the complete approved revision-bound evidence IDs for that candidate:

```json
{
  "id": "conflict-id",
  "project_id": "project-id",
  "source_id": "conflict-source-id",
  "revision_id": "conflict-revision-id",
  "evidence_ids": ["left-evidence-id", "right-evidence-id"]
}
```

Conflict candidates, including approved labels, must have at least one evidence ID. A returned match is valid only when its evidence ID set exactly equals the complete approved set; approved conflict labels should include both sides' current-revision evidence IDs.

A usable evaluation file must contain at least one query for every task and at least one Korean query. Duplicate query IDs, duplicate expected identities, empty IDs, unknown fields, and cross-project expected items are rejected.

## Candidate results JSONL schema

The results file must contain exactly one line for every golden `query_id`:

```json
{
  "query_id": "approved-query-id",
  "project_id": "project-id",
  "source_id": "query-source-id",
  "revision_id": "query-revision-id",
  "results": [
    {
      "id": "candidate-id",
      "project_id": "project-id",
      "source_id": "candidate-source-id",
      "revision_id": "candidate-active-revision-id"
    }
  ]
}
```

`results` is ordered best-first and may be empty. Query-level `project_id`, `source_id`, and `revision_id` must exactly match the golden query pin. Each candidate must include a non-empty project/source/revision identity and must belong to the query project. Conflict candidates additionally require `evidence_ids`.

The evaluator rejects unknown or missing query IDs, duplicate query result records, duplicate ranked identities, query revision mismatches, cross-project candidates, and malformed evidence IDs. Candidate revision IDs participate in identity matching, so a stale or mixed revision cannot receive credit for a current expected revision.

## Metric definitions

Metrics are macro-averaged over the relevant query group:

- **related Recall@50**: approved related identities present in the first 50 results, divided by approved identities, averaged across related queries.
- **conflict Recall@20**: approved conflict identities present in the first 20 results, divided by approved conflicts, averaged across conflict queries.
- **conflict Precision@20**: matching approved conflicts divided by returned candidates in the first 20; an empty result has precision 0, averaged across conflict queries.
- **false positives/query**: non-approved candidates in the first 20, measured as the maximum (worst case) across conflict queries.
- **evidence validity**: fraction of correctly retrieved conflict identities whose returned evidence ID set exactly equals the approved set. It is 0 when no approved conflict is retrieved.
- **phrase Recall@10**: approved phrase identities present in the first 10 results, divided by approved identities, averaged across phrase queries.
- **Korean no-result rate**: fraction of all `language: "ko"` queries whose ranked result array is empty.

Identity matching uses the complete tuple `(id, project_id, source_id, revision_id)`. Scores, snippets, latency, and model output are intentionally outside this evaluator's contract.

## Reproducibility and readiness use

An operations-authorized user first registers the query manifest content with `POST /spec-quality-readiness/query-manifests`, binding it to project, scope, reconciliation run, dataset, and version. The server computes and persists its digest. The evaluator must hash those same bytes and its stdout JSON can then be posted unchanged to `POST /spec-quality-readiness/evaluations`. The server recomputes the artifact digest, verifies every fixed check, and requires the manifest digest to match the registered binding and current clean reconciliation run.

Store the manifest, candidate results, evaluator revision, and stdout artifact immutably. OpenSearch remains disabled by default; readiness evidence does not activate a backend or alter deployment state.

## Tests

```bash
python3 -m unittest evaluation/spec-search/test_evaluate.py
```
