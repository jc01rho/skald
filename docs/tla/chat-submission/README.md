# chat-submission 영역 TLA+ 검토

대상: (A) 메모 제출(submission) 승인/거절 워크플로, (B) 채팅 SSE 스트리밍(프리뷰 → 최종 답변) 상태 머신.
소스 기준: worktree `/home/whrho/git/skald-wt/tla-review` (origin/main). 애플리케이션 코드는 수정하지 않았습니다.

실행 명령 (모든 cfg 공통):

```
cd docs/tla/chat-submission
/usr/lib/jvm/java-21/bin/java -XX:+UseParallelGC -cp /home/whrho/.local/share/tla/tla2tools.jar tlc2.TLC \
  -workers 4 -cleanup -deadlock -metadir /tmp/tlc-cs/<cfg> <Spec>.tla -config <cfg>.cfg
```

---

## A. 메모 제출 승인 (`Submission.tla`)

### 모델링 대상과 코드 매핑

| 모델 액션 | 코드 | 설명 |
| --- | --- | --- |
| `Start(q)` | 프론트 `memoSubmissionReviewStore.ts:144-185`(approve), `:187-219`(reject) | 리뷰어가 승인/거절 클릭. `reviewActionLoading`은 탭 하나 안에서만 유효하므로 두 탭/두 리뷰어/500 이후 재시도는 막지 못함 |
| `ARead` | `backend/src/api/memoSubmission.ts:616`, `:622` | `findOne` 후 `status !== 'pending'` 검사. 락/버전 없음 (`entities/MemoSubmission.ts`에 version 컬럼 없음) |
| `AFind` | `backend/src/lib/createMemoUtils.ts:382`, `:114-131` | `client_reference_id`(또는 legacy id, source_url)로 기존 메모 검색 |
| `AInsert` | `createMemoUtils.ts:390`, `:251-312` | 별도 fork em + 자체 트랜잭션으로 메모 insert 후 **즉시 commit**. 유니크 인덱스는 `client_reference_id IS NOT NULL`일 때만(`migrations/Migration20260311093000.ts:7-8`); 23505면 `:396-403` 재사용 경로 |
| `AReuse` | `createMemoUtils.ts:148-207`, `:384-387` | 기존 메모의 title/content/**metadata(submission_id 포함)** 덮어쓰기, 별도 tx commit. content hash가 같으면 enqueue 안 함(`:29-35`) |
| `AEnqueue` | `createMemoUtils.ts:407-409`, `:365-378` | 큐 publish. 예외는 `memoSubmission.ts:670-672`에서 500으로 변환되지만 메모 행은 이미 commit됨 |
| `AFlush` | `memoSubmission.ts:659-667` | `status='approved'` 를 `WHERE uuid=?` 만으로 UPDATE (조건부 아님). 실패 시 500 |
| `RRead`/`RFlush` | `memoSubmission.ts:748-766` | 거절: 같은 read-check-blind-write 패턴 |
| `Sweep(i)` | `memoProcessingServer/stuckMemoSweeper.ts:54-79`, `:99-121`; `settings.ts:88` (기본 활성) | `received` 상태로 오래된 메모를 소유 제출의 상태와 무관하게 재publish |
| `FApprove`/`FReject`/`Relay` | (제안 수정) | 한 트랜잭션에서 `UPDATE ... WHERE status='pending'` + 메모 insert + outbox 행; relay가 outbox publish |

환경: `k8s/api-deployment.yaml:15` replicas 2, 요청 간 락 없음 → 요청은 임의 interleave. 각 DB 문/큐 호출/await가 하나의 step. DB/큐 실패(또는 pod 종료)는 해당 step에서 500으로 끝나는 비결정 분기로 모델링.

추상화: 메모의 "처리됨(enq)"은 publish가 한 번이라도 됐다는 뜻이며, 처리되면 `is_public=true`(`memoSubmission.ts:652`) 이므로 `listPublicMemos`(`:797-838`)와 RAG 검색에 노출된다고 봅니다. 메모 소유자 `owner` = `metadata.submission_id`. 서로 다른 제출은 content가 다르다고 가정(재사용 시 enqueue 여부 = owner가 바뀌었는지).

### 속성

| 이름 | 의미 |
| --- | --- |
| `NoDuplicateMemo` | 제출 하나당 메모 ≤ 1 |
| `DecisionFinal` | 한 번 결정된 status(승인/거절)가 다른 값으로 바뀌지 않음 |
| `NoConflictingSuccess` | 같은 제출에 승인 200과 거절 200이 동시에 나가지 않음 |
| `RejectedHasNoMemo` | 거절된 제출에는 메모가 없음 |
| `ApprovedHasMemo` | (요청이 없는 시점) 승인된 제출은 자기 메모를 가짐 |
| `OkImpliesProcessed` | 승인 200을 받았으면 메모가 큐에 들어갔거나 outbox에 있음 |
| `PublishedOnlyIfApproved` | (요청이 없는 시점) 처리(공개)된 메모의 제출은 승인 상태 |
| `ApprovedEventuallyProcessed` (liveness) | 승인된 제출의 메모는 결국 처리됨 (Relay/Sweep에 WF) |
| `OutboxDrains` (liveness, fix 전용) | outbox 행은 결국 비워짐 |

### TLC 결과 (2026-11-02 재실행)

| cfg | 상수 요약 | 검사 속성 | 결과 | distinct states | depth | 시간 |
| --- | --- | --- | --- | --- | --- | --- |
| `Submission_dup` | 1 제출, 2 요청, ref 없음 | NoDuplicateMemo | **위반** | 139 | 9 | 1.2s |
| `Submission_flip` | 1 제출, 2 요청, ref 없음 | DecisionFinal | **위반** | 154 | 10 | 1.2s |
| `Submission_conflict` | 동일 | NoConflictingSuccess | **위반** | 155 | 10 | 1.0s |
| `Submission_rejmemo` | 동일 | RejectedHasNoMemo | **위반** | 117 | 8 | 1.5s |
| `Submission_leak` | 동일 | PublishedOnlyIfApproved | **위반** | 125 | 9 | 1.0s |
| `Submission_orphan` | ref 있음, sweeper 끔 | OkImpliesProcessed | **위반** | 180 | 11 | 1.2s |
| `Submission_orphan_sweeper` | ref 있음, sweeper 켬 | ApprovedEventuallyProcessed | 통과 | 208 | 12 | 1.1s |
| `Submission_sharedref` | 2 제출이 같은 ref | ApprovedHasMemo | **위반** | 766 | 12 | 1.4s |
| `Submission_fixed` | FIX, 2 제출 같은 ref, 3 요청 | 7개 불변식 + 2개 liveness | 통과 | 3,091 | 8 | 1.8s |
| `Submission_fixed_noref` | FIX, ref 없음, 3 요청 | 7개 불변식 + 2개 liveness | 통과 | 3,937 | 9 | 1.9s |

### 발견 사항

#### S1. 승인/거절 경쟁: 거절 200 이후 승인으로 뒤집힘 (medium, CONFIRMED)
- cfg: `Submission_flip`, `Submission_conflict`
- trace: 리뷰어 B가 거절 요청 → `RRead`에서 pending 확인. 리뷰어 A의 승인 요청도 `ARead`에서 pending 확인. 거절이 먼저 flush(`rejected`, 200). 승인 요청은 이미 검사를 통과했으므로 메모 생성·enqueue 후 `status='approved'`로 덮어씀(200). 두 사람 모두 성공 응답을 받고, 최종 상태는 거절 사실이 사라진 승인 + 공개 메모.
- 근거: `memoSubmission.ts:616-622`(검사)와 `:659-667`(쓰기) 사이에 `createNewMemo`의 여러 await(`:641`)가 끼어 있음. `:748-766`도 같은 패턴. UPDATE에 `status='pending'` 조건 없음, 엔티티에 version 없음.
- 수정: `UPDATE skald_memo_submission SET status=? ... WHERE uuid=? AND status='pending' RETURNING` (또는 `SELECT ... FOR UPDATE`)으로 상태 전이를 원자화하고, 영향 행이 0이면 409.

#### S2. 거절된/미결 제출의 내용이 공개 메모로 처리됨 (high, CONFIRMED)
- cfg: `Submission_rejmemo`, `Submission_leak`
- rejmemo trace: 승인 요청이 메모 insert(commit) 직후, 거절 요청이 끼어들어 `rejected`로 flush. 이 시점 거절된 제출에 공개 메모가 존재하고, 승인 요청이 enqueue하면 처리되어 공개 목록과 RAG에 노출됨. 승인의 마지막 flush가 실패하면 영구히 "거절됨 + 공개 메모"로 남고, 성공하면 S1(뒤집힘)이 됨.
- leak trace: 단일 승인 요청이 메모 insert + enqueue 후 `persistAndFlush`(`:667`)에서 실패(또는 pod 종료) → 500, 제출은 여전히 pending. 메모는 처리되어 `is_public=true`로 공개. 리뷰어가 이후 거절해도 메모는 삭제되지 않음(거절 경로 `:758-766`에 메모 정리 없음).
- 근거: 메모 insert는 `createMemoUtils.ts:252-306` 자체 fork em 트랜잭션에서 즉시 commit, enqueue는 `:408`, 제출 상태 쓰기는 별도의 `DI.em`(`memoSubmission.ts:667`). 세 쓰기가 원자적이지 않음. 공개 조회는 제출 상태를 보지 않음(`:797-838`은 `metadata.is_public`만 확인).
- 분류: 인터리빙(rejmemo)은 CONFIRMED. leak의 트리거(마지막 flush 실패/pod 종료)는 NEEDS-RUNTIME 성격이지만 코드상 경로는 존재.
- 수정: 상태 전이 + 메모 insert + outbox 행을 한 트랜잭션으로 묶고, publish는 commit 이후 outbox relay가 수행 (`Submission_fixed*`에서 검증). 최소 수정이라면 S1의 조건부 UPDATE를 메모 생성 **이전**에 수행(pending→approving)하고 실패 시 메모 archive.

#### S3. 이중 승인 시 메모 중복 생성 (medium, CONFIRMED)
- cfg: `Submission_dup`
- trace: 같은 제출에 승인 요청 2개(두 탭, 또는 500 후 재시도)가 모두 `ARead` 통과 → reference_id가 없으므로 `findExistingMemoForCreate`가 아무것도 못 찾고, 유니크 인덱스도 NULL에는 적용되지 않음 → 두 요청 모두 insert. 같은 내용의 공개 메모 2개가 처리되어 검색 결과 중복.
- 근거: `createMemoUtils.ts:114-131`(ref·source_url 없으면 null), `Migration20260311093000.ts:7-8`(partial index `WHERE client_reference_id IS NOT NULL`). 참고: `publicMemoSubmissionStore.ts:132`는 `client_reference_id`라는 필드명으로 보내지만 백엔드 zod 스키마(`memoSubmission.ts:9-22`)는 `reference_id`만 받으므로 값이 버려짐 → 이 UI 경로의 제출은 항상 ref가 없어 이 결함에 노출됨. (`memoSubmissionStore.ts:116`은 `reference_id`로 올바르게 보냄.)
- 수정: S1의 조건부 UPDATE가 두 번째 요청을 막음. 추가로 `metadata->>'submission_id'`에 대한 유니크 제약 또는 메모 uuid를 제출 uuid에서 결정적으로 파생.

#### S4. enqueue 실패 후 재시도 성공 시 메모가 처리되지 않은 채 "승인됨" (low, CONFIRMED)
- cfg: `Submission_orphan` (위반), `Submission_orphan_sweeper` (liveness 통과)
- trace: 첫 승인 요청이 메모 insert 후 publish에서 실패 → 500(메모는 `received`로 남음, 제출 pending). 리뷰어 재시도 → 같은 reference_id로 기존 메모를 재사용, content hash가 같아서 `shouldEnqueueMemoProcessing`이 false → publish 없이 200 "승인됨". 메모는 `received`에 머무름.
- 근거: `createMemoUtils.ts:384-387`, `:29-35`, `:407-409`.
- 완화: stuck memo sweeper(`stuckMemoSweeper.ts:54-79`, 기본 활성 `settings.ts:88`)가 `receivedStaleMinutes` 후 재publish하므로 결국 처리됨(`Submission_orphan_sweeper` 통과). 다만 sweeper는 큐가 idle일 때만 동작(`:99-103`)하므로 지연은 부하에 의존(NEEDS-RUNTIME). 같은 sweeper가 S2의 "미결/거절 제출 메모"도 재publish하므로 S2를 악화시킴.
- 수정: outbox 패턴(S2 수정에 포함), 또는 재사용 시 `processing_status !== 'processed'`면 enqueue.

#### S5. 같은 reference_id를 가진 두 번째 제출 승인이 첫 번째 승인의 메모를 빼앗음 (medium, CONFIRMED)
- cfg: `Submission_sharedref`
- trace: 제출 s1 승인 완료(메모 m1, submission_id=s1). 이후 같은 reference_id의 제출 s2 승인 → `findExistingMemoForCreate`가 m1을 찾고 `reuseExistingMemoForCreate`가 m1의 content와 metadata(submission_id=s2)를 덮어씀. s1은 "승인됨"이지만 자기 메모가 없음(`getAuthMemoSubmission`의 `metadata->>'submission_id'` 조회 `memoSubmission.ts:581-591`가 null). s2의 enqueue가 실패하면 s2는 pending인데 공개 메모는 s2 내용으로 바뀜.
- 근거: `createMemoUtils.ts:148-160`(metadata 통째로 교체), `memoSubmission.ts:647`(사용자 입력 reference_id 그대로 전달). reference_id는 **인증 없는** 공개 제출 API(`memoSubmission.ts:915-916`, `expressServer.ts:105`)에서 임의로 지정 가능하므로, 수집기가 만든 메모의 `client_reference_id`를 지정한 제출이 승인되면 그 메모 내용이 덮어써짐(모델의 "다른 owner 메모" 경우와 동일한 메커니즘; 별도 cfg 없이 코드로 확인).
- 수정: 승인 시 찾은 메모의 `metadata.submission_id`가 다른 제출(또는 없음 = 비제출 메모)이면 재사용을 거부하고 409 (`FApprove`의 `foreign` 검사, `Submission_fixed`에서 검증). 또는 제출의 reference_id를 네임스페이스(`submission:<uuid>`)로 격리.

### 수정안 검증
`FIX=TRUE`(`FApprove`/`FReject`/`Relay`): 단일 트랜잭션 + 조건부 상태 전이 + 다른 소유자 메모 재사용 거부 + outbox. `Submission_fixed`(같은 ref 공유, 3요청)와 `Submission_fixed_noref`에서 7개 불변식과 `OutboxDrains`, `ApprovedEventuallyProcessed`가 모두 통과.

### 의도적으로 모델링하지 않은 것
- 프리뷰 재생성(`regenerateMemoSubmissionPreview`, backfill)과 승인의 경쟁: 프리뷰는 pending 제출의 부가 필드만 갱신.
- 메모 처리 파이프라인 내부(청킹/임베딩)와 sweeper의 EXHAUST 경로: "처리됨" 한 비트로 추상화.
- 메모 삭제/아카이브, 제출 생성 경로의 동시성.

---

## B. 채팅 SSE 스트리밍 (`ChatStream.tla`)

대상: 프리뷰 → 최종 답변 SSE 흐름의 서버 핸들러, `api.stream` fetch reader, Zustand 스토어. `MODE="private"`는 `backend/src/api/chat.ts` + `frontend/src/stores/chatStore.ts`(Playground/온보딩), `MODE="public"`은 `ee/src/api/publicChat.ts`(`/api/public_chat/:slug`, `ee/src/enterpriseServer.ts:9`) + `frontend/src/stores/publicChatStore.ts`입니다. 공개 채팅 프론트는 같은 이벤트 핸들러를 쓰지만 백엔드는 별도 구현이라 `accepted`/`preview` 이벤트가 없습니다.
소스 기준: worktree HEAD(acb7241). 최신 main(13674ac)과의 차이는 `ragGraph.ts`의 리랭크·컨텍스트 문자열뿐이라 이벤트 순서에는 영향이 없습니다.

### 모델링 대상과 코드 매핑

스트림 s 하나 = `sendMessage` 호출 하나 = HTTP 요청 하나. 서버 step은 핸들러의 await 하나, 클라이언트 step은 `reader.read()` 하나(이벤트 하나 처리)입니다. 메시지 내용은 종류(`empty`/`preview`/`answer`/`error`/`garbled`)로, 토큰 스트림은 토큰 1개(= 전체 답변)로 추상화했습니다.

| 모델 액션 | 코드 | 설명 |
| --- | --- | --- |
| `Send` | `chatStore.ts:168-185`, `:198-201`, `:233`; `publicChatStore.ts:82-115`; 입력 비활성 `ChatInput.tsx:20,45`, `PublicChatInput.tsx:29,46,56` | `isStreaming`이 false일 때만 전송. 요청에 현재 `chatSessionId`를 실음. `api.stream`이 돌려주는 abort 함수는 버려짐 |
| `PPersistUser` | `chat.ts:609-620`(헤더·ping·keepAlive), `:623`(createChatWithUserMessage), `:626`(accepted) | `:623`은 `try`(`:685`) 밖. 실패 시 Express 오류 체인 `expressServer.ts:149-159`가 헤더 전송 후 `res.json` → `ERR_HTTP_HEADERS_SENT` → 소켓 파괴, keepAlive는 `finally`(`:777`)에 도달하지 않아 계속 돎 |
| `PPreview` | `chat.ts:631-666`, `:686-688` | 캐시/fastRetrieve+generatePreview. 프리뷰 단계는 reject하지 않음(`:662-665`) |
| `PEarlyReject` | `chat.ts:668-676`(deepStagePromise 생성), `:686`, `:691` | ragGraph가 프리뷰 대기 중에 reject하면 처리기 없는 rejection. Node 24(`backend/Dockerfile:25`) 기본값 `--unhandled-rejections=throw`, express 모드는 `Sentry.init`을 하지 않음(`backend/src/sentry.ts`는 `memoProcessingServer.ts:17`만 import) → 프로세스 종료 |
| `PDeep`/`PGen`/`PPersist` | `chat.ts:691`, `:703-726`, `:747-748`; catch `:749-775` | 실패는 모두 `error` 이벤트. 저장 실패는 토큰을 다 보낸 뒤에 `error` |
| `QRag` | `publicChat.ts:68-74`(헤더 전), `:126-129` | 헤더 전 실패 → 503 JSON → `api.ts:239-253` |
| `QGen` | `publicChat.ts:135-158` | 생성 실패 시 `error`를 쓰고 **그대로 반환** → `:88-89`에서 빈/부분 답변 저장 + `done` |
| `QPersist` | `publicChat.ts:88-93` | 저장 실패 → catch에서 헤더 전송 후 `res.status(503).json` → 소켓 파괴 |
| `EndStep` | `chat.ts:776-779`, `publicChat.ts:90` | `res.end()` → 클라이언트는 정상 EOF |
| `Cut` | `expressServer.ts:177-183`(SIGTERM 후 30초에 강제 exit), 네트워크 | 끊김이 fetch에 정상 EOF로 보이는지(`CutIsEOF`) 오류로 보이는지는 ingress/브라우저 동작 |
| `HangStep` | DB/ragGraph/LLM await 전부, `previewAgent.ts:48`, `llmService.ts`(timeout 없음) | keepAlive ping(`chat.ts:614-620`) 때문에 연결은 영원히 열려 있음 |
| `Deliver` | `api.ts:264-291` → `chatStore.ts:236-321` = `publicChatStore.ts:118-196` | accepted(`:237-239`), preview(`:246-276`), token(`:279-282`), done(`:290-314`), error(`:315-321`) |
| `ParseFail` | `api.ts:279-286`, `:291` | JSON.parse 실패 → `onError` 후에도 계속 읽음 |
| `EOF` | `api.ts:268-270` | `if (done) return` — `onMessage`도 `onError`도 호출하지 않음 |
| `Fail` | `api.ts:239-253`, `:293-297`, `:303-307` → `chatStore.ts:323-333` | `finishStreaming` + 메시지 내용을 `Error: ...`로 교체 |
| `Clear` | `chatStore.ts:339-341`, `publicChatStore.ts:213-215`; 호출처 `ChatWithSuggestionsStep.tsx:42-48,92`(스트리밍 중엔 버튼이 렌더되지 않음), `PublicChatPage.tsx:22-25`(mount·slug 변경마다) | 메시지와 `chatSessionId`만 지움. 스트림 abort 없음, `isStreaming` 그대로 |
| `TabClose` | 두 핸들러 모두 `req.on('close')`/AbortSignal 없음 | 서버는 클라이언트가 떠난 걸 모름 |

스토어의 `isStreaming`, `currentStreamingMessageId`, `chatSessionId`는 스트림 구분 없이 전역 하나이고, 메시지 내용 갱신만 클로저의 메시지 id(`chatStore.ts:175-176`, `:266`)로 키잉됩니다. 스토어는 모듈 전역이라 컴포넌트가 unmount돼도 스트림은 같은 스토어에 계속 씁니다.

### 속성

| 이름 | 의미 |
| --- | --- |
| `PreviewNeverOverwrites` (action) | 프리뷰는 빈 메시지에만 들어감. 답변/오류가 든 메시지를 프리뷰로 덮지 않음 (질문 1) |
| `SessionFresh` | 현재 `chatSessionId`는 지금 대화(마지막 clear 이후)에서 만들어진 채팅 (질문 2) |
| `NoStaleChatReuse` | clear 이후 보낸 요청이 clear 이전 서버 채팅을 이어 쓰지 않음 (질문 2) |
| `StreamingFlagSound` | `isStreaming`이면 실제로 살아 있는 스트림이 있음 (질문 3) |
| `SpinnerSound` | 메시지 스피너(`isStreaming` 메시지)는 살아 있는 스트림에만 붙음 |
| `IdleConsistent` | `isStreaming`이 false인데 스피너가 도는 메시지가 없음 (= 다른 스트림이 전역 플래그를 끄지 않음) |
| `BusyVisible` | 입력이 막혀 있으면(`isStreaming`) 화면에 진행 중 메시지가 보임 |
| `EventuallyIdle` (liveness) | `isStreaming`은 결국 false가 됨 (서버·reader step에 WF, 사용자 행동·장애에는 공정성 없음) |
| `NoLostAnswer` | 서버가 끝까지 생성해 화면에 다 나온 답변이 `Error: ...`로 교체되지 않음 |
| `SingleTerminal` | 스트림당 terminal 이벤트(`done`/`error`)는 최대 1개 |
| `NoLeakedKeepAlive` | 요청이 끝난 뒤 keepAlive interval이 남지 않음 |
| `NoCrash` | 처리되지 않은 rejection으로 API 프로세스가 죽지 않음 |
| `NoWastedGeneration` | 클라이언트가 떠난 뒤 서버가 생성·저장을 계속하지 않음 |

### TLC 결과 (2026-11-03, N=2 스트림, clear 최대 1회)

위반 행의 distinct states는 위반을 찾을 때까지 탐색한 수, trace는 반례 상태 수입니다.
위반 cfg를 실행하면 TLC가 spec 폴더에 `ChatStream_TTrace_*.tla/.bin`을 만듭니다. 재실행할 때는 `-noGenerateSpecTE`를 붙이거나 실행 후 지우세요.

| cfg | 상수 요약 | 검사 속성 | 결과 | distinct states | depth/trace | 시간 |
| --- | --- | --- | --- | --- | --- | --- |
| `ChatStream_private_ok` | private, DeepFail | 타입·UI 불변식 7개 + SingleTerminal/NoLeakedKeepAlive/NoCrash + PreviewNeverOverwrites + EventuallyIdle | 통과 | 704 | depth 26 | 0.5s |
| `ChatStream_public_ok` | public, 실패 없음, clear 없음 | 동일 | 통과 | 61 | depth 19 | 0.3s |
| `ChatStream_leak` | private, DBFail | NoLeakedKeepAlive | **위반** (NoLeakedKeepAlive) | 84 | trace 3 | 0.4s |
| `ChatStream_lost` | private, DBFail | NoLostAnswer | **위반** (NoLostAnswer) | 115 | trace 11 | 0.4s |
| `ChatStream_crash` | private, EarlyReject | NoCrash | **위반** (NoCrash) | 69 | trace 4 | 0.4s |
| `ChatStream_eof` | private, CutOn, CutIsEOF | StreamingFlagSound | **위반** (StreamingFlagSound) | 44 | trace 4 | 0.4s |
| `ChatStream_eof_live` | 동일 | EventuallyIdle | **위반** (EventuallyIdle, liveness) | 780 | trace 5 | 0.5s |
| `ChatStream_cut_err` | private, CutOn, 끊김=오류, DeepFail | IdleConsistent | **위반** (IdleConsistent) | 541 | trace 11 | 0.4s |
| `ChatStream_cut_err_live` | 동일 | EventuallyIdle | 통과 | 6,080 | depth 26 | 0.6s |
| `ChatStream_hang` | private, Hang | 타입·UI 불변식 7개 + EventuallyIdle | **위반** (EventuallyIdle, liveness) | 388 | trace 3 | 0.5s |
| `ChatStream_parse` | private, ParseErr | IdleConsistent | **위반** (IdleConsistent) | 98 | trace 7 | 0.4s |
| `ChatStream_tabclose` | private, TabCloseOn | NoWastedGeneration | **위반** (NoWastedGeneration) | 42 | trace 7 | 0.3s |
| `ChatStream_public_clear` | public, clear 1회 | SessionFresh | **위반** (SessionFresh) | 54 | trace 9 | 0.5s |
| `ChatStream_public_reuse` | 동일 | NoStaleChatReuse | **위반** (NoStaleChatReuse) | 65 | trace 10 | 0.4s |
| `ChatStream_public_busy` | 동일 | BusyVisible | **위반** (BusyVisible) | 64 | trace 3 | 0.4s |
| `ChatStream_public_terminal` | public, DeepFail | SingleTerminal | **위반** (SingleTerminal) | 35 | trace 5 | 0.4s |
| `ChatStream_public_late_done` | public, DeepFail | IdleConsistent | **위반** (IdleConsistent) | 147 | trace 9 | 0.6s |
| `ChatStream_public_lost` | public, DBFail | NoLostAnswer | **위반** (NoLostAnswer) | 92 | trace 8 | 0.4s |
| `ChatStream_fixed_private` | FIXC+FIXS, private, 환경 스위치 전부 켬(끊김=EOF) | 불변식 12개 + PreviewNeverOverwrites + EventuallyIdle | 통과 | 158,981 | depth 24 | 5.9s |
| `ChatStream_fixed_private_reset` | 동일, 끊김=오류 | 동일 | 통과 | 189,884 | depth 24 | 6.4s |
| `ChatStream_fixed_public` | FIXC+FIXS, public, 환경 스위치 전부 켬(끊김=EOF) | 동일 | 통과 | 20,826 | depth 18 | 1.2s |
| `ChatStream_fixed_public_reset` | 동일, 끊김=오류 | 동일 | 통과 | 24,666 | depth 18 | 1.3s |

### 런타임 재현 (모델 밖에서 확인한 전제)

`$RUN_TMP`의 일회용 스크립트로 확인했고 저장소에는 남기지 않았습니다.
1. Node v24.22.0: 처리기 없이 먼저 reject된 promise를 나중에 `await`하는 `chat.ts:668/686/691` 모양의 코드 → `try/catch`가 있어도 프로세스가 exit 1로 종료되고 `catch`는 실행되지 않음.
2. Express 5.1.0(`backend/node_modules`): SSE 헤더와 ping을 쓴 뒤 핸들러가 throw하고 `expressServer.ts:149-159`와 같은 `onError`가 `res.json`을 호출 → `ERR_HTTP_HEADERS_SENT`, 클라이언트 reader는 `UND_ERR_SOCKET`으로 reject, keepAlive interval은 그 뒤에도 600ms 동안 6번 `res.write`를 예외 없이 실행(정리되지 않음).

### 발견 사항

#### C1. 프리뷰 대기 중 ragGraph가 실패하면 API 프로세스가 죽음 (high, CONFIRMED / 빈도 NEEDS-RUNTIME)
- cfg: `ChatStream_crash`
- trace: 요청 1이 프리뷰 생성(LLM)을 기다리는 동안 `deepStagePromise`(ragGraph)가 reject → 아직 아무도 그 promise를 await하지 않음 → unhandled rejection → 프로세스 종료 → 같은 pod의 모든 스트림이 끊김.
- 근거: `chat.ts:668`에서 promise를 만들고 `:686`의 `await fastPreviewPromise` 뒤인 `:691`에서야 await. 캐시 미스 경로는 `fastRetrieve` + `generatePreview` LLM 호출(`:647-666`)이라 수 초 걸리고, ragGraph의 DB·임베딩 노드(`getChatHistory`, `exactLookup`, `vectorSearch` 등, `ragGraph.ts:2019-2030`)는 그보다 빨리 실패할 수 있음. express 모드에는 `unhandledRejection` 처리기가 없음(`rg unhandledRejection backend/src ee/src` 0건, Sentry 미초기화). 런타임 재현 1로 Node 동작 확인.
- 수정: `deepStagePromise.catch(() => {})`로 처리기를 즉시 달고 나중에 원래 promise를 await(또는 `Promise.allSettled`). 프로세스 수준 `unhandledRejection` 로깅 처리기도 추가.

#### C2. 연결이 terminal 이벤트 없이 정상 EOF로 끝나면 UI가 영원히 스트리밍 상태 (medium, NEEDS-RUNTIME / 클라이언트 처리 누락은 CONFIRMED)
- cfg: `ChatStream_eof`, `ChatStream_eof_live`(liveness 반례: Send → Cut → EOF → 정지)
- trace: 스트림 도중 pod 종료(`expressServer.ts:180-183`, 30초 후 강제 exit) 또는 프록시가 upstream 끊김을 정상 종료로 전달 → reader가 `done=true` → `api.ts:268-270`이 그냥 return → `done`/`error`도 `onError`도 오지 않음 → `isStreaming=true`, 스피너 유지, 입력 비활성(`ChatInput.tsx:45`). 새로고침 전까지 복구 불가.
- 근거: 클라이언트 쪽은 코드로 확정. 끊김이 정상 EOF로 보이는지는 ingress(nginx)와 브라우저 동작이라 확인 불가. 직접 연결의 chunked 응답은 오류로 보일 가능성이 높음(`ChatStream_cut_err_live`: 끊김이 오류로 보이면 liveness 통과).
- 수정: reader가 끝났는데 terminal 이벤트를 못 받았으면 `onError`(`FIXC`의 `EOF`).

#### C3. 서버 await가 멈추면 UI도 영원히 스트리밍, 사용자가 멈출 방법 없음 (medium, NEEDS-RUNTIME)
- cfg: `ChatStream_hang` (불변식은 모두 통과, `EventuallyIdle`만 위반: Send → HangStep → 정지)
- trace: DB/ragGraph/LLM 호출 중 하나가 응답하지 않음 → keepAlive ping이 15초마다 연결을 살려 둬서 프록시 타임아웃도 안 걸림 → 클라이언트는 무한 대기.
- 근거: `chat.ts:614-620`(ping), `:623`, `:631`, `:686`, `:691`, `:707`, `:747`의 await에 timeout/AbortSignal 없음. 클라이언트는 `api.stream`의 abort 함수(`api.ts:310-312`)를 버림(`chatStore.ts:233`, `publicChatStore.ts:115`), 정지 버튼·idle timeout 없음. 실제로 멈추는 호출이 있는지는 런타임 확인 필요.
- 수정: 서버 단계별 timeout(AbortSignal.timeout)과, 클라이언트 abort 함수 보관 + 정지 버튼 + 마지막 이벤트 이후 idle timeout.

#### C4. 사용자 메시지 저장 실패 시 keepAlive interval 누수, error 이벤트 없음 (medium, CONFIRMED)
- cfg: `ChatStream_leak` (Send → PPersistUser 실패)
- trace: `createChatWithUserMessage`가 throw → `try` 밖이라 `catch`/`finally`를 건너뜀 → Express 오류 체인이 헤더 전송 뒤 `res.json` → `ERR_HTTP_HEADERS_SENT` → 소켓 파괴. 클라이언트는 `Failed to get response`를 받지만, 서버의 `setInterval`은 `res.write`가 예외를 던지지 않아(`:615-619`의 `catch`가 실행되지 않음) 프로세스가 살아 있는 동안 15초마다 계속 돎. DB 장애 동안 요청마다 interval과 클로저(`res`, 요청 본문)가 쌓임.
- 근거: `chat.ts:614-623`, `:685`, `:776-779`, `expressServer.ts:149-159`. 런타임 재현 2.
- 수정: `:623`을 `try` 안으로 옮기거나 interval 생성 직후부터 바깥 `try/finally`로 감싸 `clearInterval` + `error` 이벤트 + `res.end()`. 오류 미들웨어는 `res.headersSent`면 `res.end()`만.

#### C5. 공개 채팅: 생성 실패 뒤에도 빈/부분 답변을 저장하고 `done`까지 보냄 (low, CONFIRMED)
- cfg: `ChatStream_public_terminal` (QGen 실패 → QPersist 성공: `error` 다음 `done`)
- trace: `streamChatAgent` 예외 → `error` 이벤트 → 함수가 `fullResponse`(빈 문자열 또는 일부)를 반환 → `createChatMessagePair`가 그 답변을 대화 기록에 저장 → `done`. 이후 같은 채팅의 질문은 빈 assistant 답변이 든 히스토리를 LLM에 넘김(`ragGraph.ts:365`).
- 근거: `publicChat.ts:152-159`, `:88-90`.
- 수정: 오류 시 예외를 다시 던지거나 플래그를 돌려 저장과 `done`을 건너뛰고 `res.end()`.

#### C6. 첫 terminal 이후 들어온 콜백이 새 스트림의 전역 상태를 끔 (low, CONFIRMED)
- cfg: `ChatStream_public_late_done`, `ChatStream_cut_err`
- trace (public): 스트림 1의 `error` 처리 → `isStreaming=false` → 사용자가 질문 2 전송 → 스트림 1의 늦은 `done`(C5) → `finishStreaming`이 전역 `isStreaming=false`, `chatSessionId`를 스트림 1 채팅으로 설정 → 스트림 2가 진행 중인데 입력이 다시 열려 세 번째 요청을 동시에 보낼 수 있음. private에서도 `error` 뒤 연결이 오류로 끊기면(`cut_err`) 늦은 `onError`가 같은 일을 하고 스트림 1 메시지를 `Failed to get response`로 다시 덮음.
- 근거: `chatStore.ts:147-155`(finishStreaming이 전역 플래그 리셋), `:290-333`(terminal 이후에도 reader 계속), `api.ts:264-298`. 타이밍 창은 짧음(서버 DB 저장 시간 또는 끊김 감지 지연).
- 수정: 스트림별 상태로 첫 `done`/`error`/`onError`만 처리하고 `reader.cancel()`; 전역 플래그는 "현재 스트림 id"가 같을 때만 끔.

#### C7. 끝까지 나온 답변이 저장 실패로 `Error: ...`로 바뀜 (low, CONFIRMED)
- cfg: `ChatStream_lost`(private), `ChatStream_public_lost`(public)
- trace: 토큰이 모두 표시된 뒤 `persistAssistantMessage`(`chat.ts:747`) 실패 → `error` 이벤트 → `chatStore.ts:316-320`이 답변 전체를 `Error: An error occurred`로 교체. public은 `createChatMessagePair`(`publicChat.ts:88`) 실패 → 헤더 전송 뒤 `res.status(503).json`(`:93`) → 소켓 파괴 → `onError`가 `Failed to get response`로 교체.
- 수정: 클라이언트는 이미 답변이 있으면 내용을 유지하고 "저장 실패" 표시만 붙임(`FIXC`). 서버 public은 헤더 전송 뒤에는 `error` 이벤트 + `res.end()`.

#### C8. 공개 채팅 페이지를 스트리밍 중 다시 열면 새 대화가 숨은 이전 채팅을 이어 씀 (medium, CONFIRMED)
- cfg: `ChatStream_public_clear`, `ChatStream_public_reuse`, `ChatStream_public_busy`
- trace: 질문 1 스트리밍 중 페이지 재마운트(뒤로/앞으로, slug 이동 후 복귀) → `clearMessages`(`PublicChatPage.tsx:22-25`)가 메시지와 `chatSessionId`만 지우고 스트림은 그대로 → 그동안 화면은 빈 대화인데 입력은 막혀 있음(`BusyVisible` 위반) → 스트림 1의 `done`이 `chatSessionId`를 이전 채팅으로 되살림(`publicChatStore.ts:190-192`) → 새 질문이 그 `chat_id`로 전송 → 서버가 같은 프로젝트의 그 채팅을 찾아(`chatUtils.ts:200`, `:135`) 이어 쓰고, ragGraph가 사용자에게 보이지 않는 이전 대화를 히스토리로 LLM에 넣음(`ragGraph.ts:365`, `chatUtils.ts:80-115`). 다른 slug(다른 프로젝트)면 `findOneOrFail`이 실패해 새 채팅이 생기므로 무해.
- 근거: `publicChatStore.ts:115`(abort 함수 버림), `:119-121`, `:190-192`, `:213-215`. private Playground는 clear 버튼이 `!isStreaming`일 때만 렌더돼(`ChatWithSuggestionsStep.tsx:42,92`) `ChatStream_private_ok`에서 같은 속성이 통과.
- 수정: `clearMessages`가 진행 중 스트림을 abort하고 `isStreaming=false`로 되돌리며, 핸들러는 스트림 생성 시점의 대화 세대(generation)와 다르면 모든 이벤트를 무시.

#### C9. 클라이언트가 떠나도 서버는 RAG·LLM 생성과 저장을 끝까지 함 (low, CONFIRMED)
- cfg: `ChatStream_tabclose` (Send → TabClose → 서버가 계속 진행해 PGen)
- 근거: `chat.ts:582-788`, `publicChat.ts:48-160` 어디에도 `req.on('close')`나 AbortSignal 전달이 없음. 탭을 닫아도 LLM 비용을 다 쓰고 아무도 보지 않은 답변을 저장. clear 시 abort를 넣는 C8 수정과 함께 하지 않으면 abort해도 서버 작업은 그대로 남음.
- 수정: `req.on('close')` → `AbortController.abort()`를 ragGraph/LLM 호출에 전달하고 저장 생략.

#### C10. SSE 파싱 오류 후에도 계속 읽어 상태가 꼬임 (low, MODEL-ONLY)
- cfg: `ChatStream_parse`
- trace: `JSON.parse` 실패 → `onError`(`isStreaming=false`) → reader는 계속 읽음 → 사용자가 질문 2 전송 → 두 스트림이 동시에 돌고 C6과 같은 전역 플래그 꼬임, 이후 토큰이 `Error: ...` 뒤에 붙음.
- 분류 이유: 서버가 쓰는 줄은 모두 `data: ${JSON.stringify(...)}\n\n` 한 줄(`chat.ts:626,687,703,716,748,775`, `publicChat.ts:89,145,157`)이고 `api.ts:272-274`가 줄 경계를 버퍼링하므로 현재 코드로는 파싱 실패가 나기 어려움. 프록시가 본문을 바꾸는 경우만 해당.
- 수정: 파싱 오류 시 reader를 cancel하고 스트림을 종료 처리.

#### 통과한 질문
- **오래된 프리뷰가 최종 답변을 덮는가 (질문 1): 아니오.** `PreviewNeverOverwrites`가 `private_ok`/`public_ok`/fixed 4개에서 통과. 서버는 프리뷰를 토큰보다 항상 먼저 씀(`chat.ts:687` → `:707`), 클라이언트는 첫 메시지가 활성이고 비어 있을 때만 프리뷰를 반영(`chatStore.ts:250-256`)한 뒤 별도 authoritative 메시지로 토큰을 받음(`:266-275`). 직접 응답 경로(`chat.ts:309-315`)와 public 백엔드는 프리뷰를 보내지 않음.
- **이전 스트림 이벤트가 새 메시지 내용에 들어가는가 (질문 2의 내용 측면): 아니오.** 내용 갱신은 클로저의 메시지 id로만 하고(`chatStore.ts:135-139`, `:280-286`), clear로 지워진 id에 대한 갱신은 아무 일도 하지 않음. 새는 것은 전역 필드(`chatSessionId`, `isStreaming`)뿐이며 C6·C8이 그 경우.

### 수정안 검증
`FIXC=TRUE`(클라이언트): `api.stream` abort 함수 보관, `clearMessages`에서 abort + `isStreaming=false`, 스트림별 세대 토큰으로 이전/중단/종료된 스트림 이벤트 무시, 첫 terminal 뒤 `reader.cancel()`, terminal 없는 EOF는 오류, idle timeout(정지 버튼), 파싱 오류 시 중단, 답변이 있으면 오류 때 내용 유지.
`FIXS=TRUE`(서버): `createChatWithUserMessage`를 `try` 안으로(`error` 이벤트 + `clearInterval`), `deepStagePromise`에 즉시 처리기 연결, public 생성 실패 시 저장·`done` 생략, 헤더 전송 뒤 실패는 `error` 이벤트 + `res.end()`, `req.on('close')`로 생성 중단.
`ChatStream_fixed_private`/`_reset`, `ChatStream_fixed_public`/`_reset`: 환경 스위치(DB 실패, 생성 실패, 조기 reject, 끊김 EOF/오류, hang, 파싱 오류, 탭 닫기, clear)를 모두 켠 상태에서 불변식 12개, `PreviewNeverOverwrites`, `EventuallyIdle`이 모두 통과. 첫 수정안은 terminal 이후 콜백을 무시하지 않아 `fixed_*_reset`에 해당하는 경우(C6)를 놓쳤고, 반례를 보고 `Ignore`에 `sawTerm`을 추가했습니다.

### 의도적으로 모델링하지 않은 것
- `references`/`progress` 이벤트: 클라이언트가 `progress`를 무시(`chatStore.ts:242-244`)하고 `references`는 내용과 같은 키잉이라 토큰과 동일하게 취급.
- 비스트리밍 경로(`chat.ts:349-572`, self-RAG 재생성), 응답 캐시, 직접 응답 스트리밍(`chat.ts:309-315`, await 없이 한 번에 씀), lazy reprocess.
- Discord 봇(`discord-bot/`)과 hermes 같은 다른 SSE 소비자, 같은 채팅을 여러 탭에서 동시에 쓰는 경우(서버 `sent_at` 순서로 질문/답변이 섞일 수 있으나 UI 상태 머신 밖).
- 공개 채팅 `chat_id`를 임의로 넣으면 같은 프로젝트의 다른 채팅(Playground 포함) 히스토리가 LLM 컨텍스트로 들어가는 문제(`publicChat.ts:51-52` TODO, `chatUtils.ts:22`): 보안 검토 범위라 여기서는 기록만 합니다. UUID v4라 추측은 어렵습니다.
- 공개 채팅은 ragGraph를 헤더 전에 돌려(`publicChat.ts:68`) keepAlive가 없으므로 긴 RAG는 ingress 타임아웃(504)으로 끝날 수 있음. 이 경우 `!response.ok` 경로로 정상 처리되어 모델에서는 `QRag` 실패와 같음.
