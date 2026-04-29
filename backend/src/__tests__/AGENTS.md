# BACKEND TESTS

**Generated:** 2026-04-29
**Domain:** Jest Test Suite (Score 11)

## OVERVIEW

Backend tests mix unit tests and DB-backed integration tests. DB tests share PostgreSQL state and must run serially.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Jest config | `../../jest.config.js` | `maxWorkers=1` policy |
| Test DB bootstrap | `testDb.ts` | creates `skald2_test` with pgvector extension |
| Chat integration | `chat.test.ts` | requires local PostgreSQL on `localhost:5432` |
| API/agent tests | `*.test.ts` | colocated by scenario |

## CONVENTIONS

- Put DB-requiring tests in files that intentionally use `createTestDatabase()`.
- Keep pure unit tests independent of `chat.test.ts` global DB bootstrap.
- Mock provider calls at service/agent boundaries, not by changing production code.
- Run backend Jest serially; parallel DB tests can corrupt shared state.

## ANTI-PATTERNS

- Do not delete or weaken failing tests to pass verification.
- Do not add DB-free unit tests to `chat.test.ts`.
- Do not rely on production Kubernetes secrets or live provider keys in tests.
