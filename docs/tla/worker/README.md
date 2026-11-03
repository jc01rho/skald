# worker 영역 TLA+ 검토 (docs/tla/worker)

대상: `worker/src/skald_worker/`(서킷 브레이커, Notion 증분 커서, 스케줄러/수동 /sync 겹침, 재시도)와 `discord-bot/`(스트리밍 편집기, 멘션 핸들러).
소스 기준: 워크트리 `/home/whrho/git/skald-wt/tla-review` (origin/main, acb7241).
실행 명령(모든 cfg 공통):

```
cd docs/tla/worker
/usr/lib/jvm/java-21/bin/java -XX:+UseParallelGC -cp ~/.local/share/tla/tla2tools.jar tlc2.TLC \
  -workers 4 -cleanup -deadlock -metadir /tmp/<임의> <Spec>.tla -config <Spec>_<cfg>.cfg
```

진행 상태: 이 파일은 TLC 실행이 끝날 때마다 갱신한다(중단 대비).

---

## 1. CircuitBreaker (`CircuitBreaker.tla`)

### 모델링한 것 (코드 대응)

| TLA+ 액션 | 코드 | 설명 |
| --- | --- | --- |
| `Read` | circuit_breaker.py:104-112, 138-152 | `state` 프로퍼티. OPEN이고 recovery_pending이면 한 번 OPEN을 돌려주고 플래그를 지움, 쿨다운이 지났으면 HALF_OPEN으로 전이 |
| `Enter(c)` | circuit_breaker.py:211-225 | `__aenter__`. HALF_OPEN이면 `half_open_lock.locked()` 확인 후 acquire. 비어 있는 asyncio.Lock의 acquire는 양보하지 않으므로 확인+획득은 원자적 |
| (await) | skald.py:243-255, retry.py:118-131 | 감싼 HTTP 요청(tenacity 재시도 포함) |
| `Exit(c,o)` | circuit_breaker.py:227-239, 174-209 | `__aexit__`. **누가 잡았든** 잠겨 있으면 해제(230-231), 성공/실패 기록. `o="cancel"`은 CancelledError(BaseException, 기록 없음) 및 제외 예외(4xx, skald.py:201, 186-192) |
| `REnter/RWake/RExit` | release_collector.py:530-559 | 릴리스 수집기의 "열린 회로 기다리기" 루프. `CircuitBreakerError.recovery_time`만큼 sleep |
| `Tick` | circuit_breaker.py:133-136, 195 | recovery_timeout 경과. 실패 기록 시 last_failure_time 갱신(쿨다운 리셋) |

호출자: 같은 프로세스(StatefulSet replicas 1, k8s/worker-deployment.yaml:27)의 asyncio 태스크들이 `get_circuit_breaker("skald-api")` 하나를 공유한다(skald.py:195-203). 수동 API(routes.py:132,183,228,469), 스케줄 수집기, 릴리스 수집기가 모두 같은 인스턴스를 쓴다.

상수: `FIX_LOCK`(잠금은 잡은 쪽만 해제 + HALF_OPEN에서는 프로브 결과만 반영), `FIX_RELEASE_WAIT`(거부 후 0초 sleep 금지).

### 성질
- `ProbeBound`: HALF_OPEN에서 동시에 진행 중인 프로브는 최대 1개(docstring circuit_breaker.py:11, 219).
- `LockOwned`: half_open_lock은 그것을 잡은 호출이 진행 중일 때만 잠겨 있다.
- `RelNoInstantBurn`: 릴리스 버전은 실제 시간이 흐른 뒤에만 "회로 열림"으로 포기된다(release_collector.py:522-527 docstring).
- `NotStuckOpen`, `LockEventuallyFree`(약한 공정성 하의 활성).

### TLC 결과 (2026-11-03 재실행, 소스 재대조 후 모델 변경 없음)

| cfg | 성질 | 결과 | distinct states | 시간 |
| --- | --- | --- | --- | --- |
| CircuitBreaker_probe | ProbeBound | **위반** (깊이 10) | 91 | <1s |
| CircuitBreaker_lock | LockOwned | **위반** (깊이 9) | 45 | <1s |
| CircuitBreaker_release | RelNoInstantBurn | **위반** (깊이 10) | 288 | <1s |
| CircuitBreaker_live | NotStuckOpen, LockEventuallyFree | 통과 | 3,454 | 1.2s |
| CircuitBreaker_fixed | 전부 | 통과 | 2,146 | 1.3s |

### 발견 사항

#### CB-1. HALF_OPEN 잠금을 잡지 않은 호출이 풀어 버려 프로브가 여러 개 들어감 — 중간(medium), CONFIRMED
- 반례(probe cfg): c1, c2가 CLOSED에서 진입 → c2 실패로 OPEN(임계 2) → 쿨다운 경과 → c2가 HALF_OPEN 프로브로 잠금 획득 → **CLOSED 시절에 들어간 c1이 성공으로 끝나며 `__aexit__`에서 c2의 잠금을 해제**(230-231) → c1이 다시 들어와 두 번째 프로브가 됨. 같은 경로로 c1의 성공이 HALF_OPEN의 success_count에 더해져(176-179) 프로브가 하나도 성공하지 않았는데 회로가 닫힐 수 있고, 반대로 CLOSED 시절 요청의 늦은 실패가 회로를 다시 연다(197-199).
- 근거: circuit_breaker.py:230-231(소유자 확인 없이 release), 174-182, 197-199(결과가 어느 상태에서 들어온 호출인지 구분하지 않음), 220-223.
- 영향: 백엔드가 회복 중일 때 "한 개만 시험"이 지켜지지 않아 부하가 몰리고, 회로가 성급하게 닫히거나 다시 열린다.
- 수정: 진입 시 `self._probe = True`처럼 호출별 토큰을 저장하고 `__aexit__`에서 그 토큰이 있을 때만 release, HALF_OPEN에서는 프로브 호출의 결과만 기록(FIX_LOCK=TRUE에서 TLC 통과).

#### CB-2. 잠금이 프로브 진행 중에 풀림(LockOwned) — 중간, CONFIRMED (CB-1과 같은 원인)
- 반례(lock cfg): c2가 CLOSED에서 진행 중, c1 실패 두 번으로 OPEN → 쿨다운 → c1이 프로브로 잠금 → c2가 성공 종료하며 잠금 해제. c1은 아직 진행 중인데 잠금이 비어 다른 호출이 들어올 수 있다.
- 수정: CB-1과 동일.

#### CB-3. 릴리스 수집기가 0초 sleep으로 대기 횟수를 즉시 다 써 버림 — 중간, CONFIRMED
- 반례(release cfg): 일반 호출 c2가 HALF_OPEN 프로브를 잡고 있는 동안 릴리스 수집기가 진입 → `CircuitBreakerError`의 `recovery_time`은 `time_until_recovery`인데, 상태가 OPEN이 아니면 0.0(circuit_breaker.py:124-128, 222) → `asyncio.sleep(0)`(release_collector.py:549)은 바로 돌아오고 프로브는 아직 끝나지 않음 → `release_sync_circuit_max_waits`(기본 5, config.py:145-149)번을 순식간에 소진하고 버전을 실패 처리(535-542). OPEN+recovery_pending 직후 쿨다운이 이미 지난 경우도 0초다.
- 영향: 백엔드 429 한 번으로 회로가 열린 뒤 회복 시험 중에 처리되는 릴리스 버전이 전부 즉시 실패로 집계된다(2026-09-23 릴리스 동기화 대량 실패와 같은 증상 계열).
- 수정: 대기 시간을 `max(exc.recovery_time, 최소값(예: 1s 또는 recovery_timeout/몇 분의 1))`로 하거나, HALF_OPEN 거부일 때는 프로브 종료를 기다리는 이벤트를 둔다(FIX_RELEASE_WAIT=TRUE에서 통과).

참고(통과한 것): 현재 코드에서도 `NotStuckOpen`, `LockEventuallyFree`는 공정성 가정 하에 성립한다. 즉 위 결함은 안전성(동시 프로브, 즉시 포기) 문제이고 회로가 영원히 열린 채 멈추지는 않는다.

---

## 2. NotionCursor (`NotionCursor.tla`)

### 모델링한 것 (코드 대응)

| TLA+ 액션 | 코드 | 설명 |
| --- | --- | --- |
| `Start(r)` | notion_collector.py:507-519, 546, 284-395 | `run_started_at`(508, ms 정밀도) 기록, 커서 읽기(511-519), 트리 탐색. 탐색 시점의 `last_edited_time`을 잡아 둠(318, 378). 루트 페이지가 548 검사에서 한 칸을 쓰므로 자식은 `max_pages-1`개까지만 동기화 |
| `Meta(r)` | notion_collector.py:441-452, 419-428 | 탐색 시점 값으로 stale 판정(`<= cutoff`이면 건너뜀). 444는 탐색 값을 그대로 유지 |
| `Content(r)` | notion_collector.py:454 | 블록 본문 읽기(이 순간의 내용) |
| `Upsert(r)` | notion_collector.py:469-481, skald.py:406-463 | get → 해시 비교 → update/create. 버전 검사가 없어 마지막에 쓴 쪽이 이김 |
| `Finish(r)` | notion_collector.py:587-597, sync_state.py:210-240 | 커서 := `run_started_at`. 원자적 저장(sync_state.py:138-177) |
| `Edit`/`Delete` | (Notion 사용자) | 편집은 `last_edited_time` 갱신. 삭제·이동은 다음 탐색에서 안 보임 |
| `Crash` | k8s/worker-deployment.yaml:27 | 진행 중 실행 상태만 잃고 커서 파일은 유지 |

실행 주체: 매일 cron `notion_sync_job`(scheduler.py:158-172, 355-365; APScheduler 기본 max_instances=1이라 자기 자신과는 안 겹침)과 수동 `POST /sync source=notion`(api/routes.py:401-423). 둘 사이에 잠금이 없다(CONCURRENT).
`ROUND`: Notion API는 `created_time`/`last_edited_time`을 분 단위로 내림해서 돌려준다(Notion API 변경 이력, https://stackoverflow.com/questions/71728955). 모델에서는 1분 = 3틱.

### 성질
- `NoSilentlySkippedEdit`: 실행이 없을 때, 다음 증분 실행이 "변경 없음"으로 건너뛸 페이지(내림한 편집 시각 <= 커서)는 Skald에 최신 내용이 이미 있어야 한다. 아니면 그 편집은 다음 편집(다른 분) 전까지 영영 반영되지 않는다.
- `NoStaleOrphan`: 마지막으로 끝난 실행 시작 전에 삭제된 페이지는 Skald에 남아 있으면 안 된다.

### TLC 결과 (2026-11-03)

| cfg | 성질 | 결과 | distinct states | 시간 |
| --- | --- | --- | --- | --- |
| NotionCursor_concurrent | NoSilentlySkippedEdit | **위반** (깊이 24) | 7,784,117 (중단 시점) | 16s |
| NotionCursor_orphan | NoStaleOrphan | **위반** (깊이 14) | 98,749 | 1s |
| NotionCursor_round | NoSilentlySkippedEdit | **위반** (깊이 13) | 9,629 | <1s |
| NotionCursor_trunc | NoSilentlySkippedEdit | **위반** (깊이 10) | 27,317 | <1s |
| NotionCursor_fixed | 둘 다 (ROUND, CONCURRENT, DELETE, CRASH 모두 켬) | 통과 | 128,279,228 | 316s |

### 발견 사항

#### NC-1. 수동 /sync와 cron이 겹치면 오래된 본문이 새 본문을 덮고 커서가 지나가 영구 누락 — 중간, CONFIRMED
- 반례(concurrent): cron이 t1에 시작해 p3 본문(v0)을 읽음 → 사용자가 t2에 p3 편집(v1) → 수동 /sync가 t3에 시작해 p3를 v1로 upsert → **cron이 들고 있던 v0을 upsert해서 v1을 덮음**(skald.py:438-453, 해시가 다르니 update) → cron이 커서 1, 수동이 커서 3을 기록 → p3의 편집 시각 2 <= 커서 3이라 이후 증분 실행은 p3를 계속 건너뜀. Skald에는 옛 본문이 남는다.
- 근거: api/routes.py:401-407(잠금 없이 `sync_all()` 호출), scheduler.py:158-163, notion_collector.py:446, 587-597, skald.py:429-453(조건부 쓰기 없음).
- 수정: 소스별 `asyncio.Lock`을 수집기에 두고 cron·수동이 같이 잡기(이미 돌고 있으면 409). FIX의 single-flight로 통과.

#### NC-2. 실행 시작과 같은 분에 일어난 편집이 사라짐 — 중간, CONFIRMED
- 반례(round): cron이 t1(분 시작 0 안)에 시작해 p1을 동기화 → 같은 분 t2에 p1 편집 → 실행 종료로 커서 = t1(ms) → Notion은 p1의 `last_edited_time`을 분 단위로 내린 0으로 돌려줌 → 0 <= t1이라 다음 실행이 건너뜀. 다음에 다른 분에 다시 편집될 때까지 반영 안 됨.
- 근거: notion_collector.py:508, 594-596(ms 커서), 419-428(`<=` 비교), Notion의 분 단위 내림.
- 영향: 기본 cron은 01:00(scheduler.py:358-361, config.py:245-252, 파드 시간대 기준)이고 수동 /sync는 언제든 가능. 실행 중 편집은 흔하다.
- 수정: 커서를 `floor_to_minute(run_started_at) - 1ms`로 저장(또는 `<` 비교 + 1분 겹침). FIX에서 통과.

#### NC-3. 삭제·이동된 Notion 페이지가 Skald에 영원히 남음 — 중간, CONFIRMED
- 반례(orphan): t2에 시작한 실행이 p2를 동기화 → t3에 p2 삭제 → t4에 시작한 다음 실행은 p2를 못 보고 성공으로 끝남 → p2 메모는 그대로 남는다.
- 근거: `sync_all`(notion_collector.py:497-611)은 upsert만 하고, 수집기 어디에도 삭제 경로가 없다(`delete_memo` 호출 없음).
- 영향: 지운 위키 내용이 검색·채팅 답변에 계속 나온다.
- 수정: 잘리지 않은 성공 실행이 끝날 때 이번에 본 페이지 집합에 없는 `notion:` 메모를 삭제(또는 archived). FIX에서 통과.

#### NC-4. max_pages로 잘린 실행도 커서를 전진시켜 잘린 페이지가 영구 누락 — 낮음, CONFIRMED (발생 여부는 트리 크기에 달림, NEEDS-RUNTIME)
- 반례(trunc, MaxPages=3): 페이지 3개 중 2개만 동기화되고 커서 = t1 → p1 삭제로 p3가 범위 안에 들어옴 → p3 편집 시각 0 <= 커서라 건너뜀. p3는 한 번도 Skald에 들어가지 않는다.
- 근거: notion_collector.py:548-556(잘림), 325-395(탐색도 잘림), 587-597(잘려도 성공 기록 + 커서 전진).
- 영향: 루트 아래 페이지가 `notion_max_pages`(기본 500, config.py:257-260)를 넘을 때만. 운영 트리 크기는 확인하지 않았다.
- 수정: 잘린 실행이면 커서를 유지하거나 경고 실패로 기록. FIX에서 통과.

참고: 커서가 뒤로 가는 경우(cron이 늦게 끝나 더 이른 `run_started_at`을 씀)는 재동기화만 늘리므로 결함으로 치지 않았다. `fixed` 실행은 316초로 BRIEF 권장(5분)을 조금 넘었다.

---

## 3. 스케줄러 겹침과 재시도 (`Scheduler.tla`)

### 모델링한 것 (코드 대응)

| TLA+ 액션 | 코드 | 설명 |
| --- | --- | --- |
| `Start("cron")` | scheduler.py:279-370 | `add_job`에 max_instances를 안 주므로 APScheduler 3.11.2(worker/uv.lock:37-38) 기본값 1. 실행 중이면 그 회차는 건너뜀 |
| `Start(m)` | api/routes.py:239-459 | 수동 /sync는 요청 안에서 `sync_all()`을 await. 잡과 공유하는 잠금이 없어 몇 개든 동시에 돈다 |
| `Fetch` | jira_collector.py:574-584 | 소스에서 항목 읽기 |
| `WriteOk` | skald.py:406-463, backend createMemoUtils.ts:380-404 | upsert. POST create도 백엔드에서 고유 제약 위반 시 기존 메모를 재사용하므로 결국 "마지막에 쓴 쪽이 이김" |
| `WriteFail` | retry.py:91-130, skald.py:243-255 | 시도 1회 실패. `stop_after_attempt(3)`, `wait_exponential(max 30s)`, httpx timeout 60s(skald.py:218). 3회째 실패면 항목 실패 |

### 성질
- `NoRegression`(행동 성질): Skald의 항목 버전은 뒤로 가지 않는다.
- `RunsTerminate`: 시작한 실행은 끝난다(재시도 유한).
- `EventuallyFresh`: 편집이 멈추면 Skald는 최신 버전으로 수렴한다(백엔드가 결국 응답한다는 강한 공정성 가정).

### TLC 결과 (2026-11-03)

| cfg | 성질 | 결과 | distinct states | 시간 |
| --- | --- | --- | --- | --- |
| Scheduler_overlap | NoRegression | **위반** (깊이 8) | 502 | <1s |
| Scheduler_live | RunsTerminate, EventuallyFresh | 통과 | 79,412 | 10s |
| Scheduler_fixed | 전부 | 통과 | 11,518 | 1s |

### 발견 사항

#### SC-1. 수동 /sync와 예약 잡이 겹치면 옛 내용이 새 내용을 덮음 — 낮음, CONFIRMED
- 반례(overlap): cron과 수동이 같이 시작 → 수동이 v0을 읽음 → 편집 v1 → cron이 v1을 읽어 씀 → **수동이 v0을 씀**. Skald가 v1에서 v0으로 되돌아간다.
- 근거: api/routes.py:256-266(jira), 401-407(notion), 425-433(release/userdata) 모두 잠금 없이 `sync_all()`; scheduler.py에도 잠금 없음; skald.py:429-453.
- 영향: Jira는 10분마다 `updated >= -1d`로 다시 읽어서(config.py:48-55) 다음 폴링에 회복된다(`Scheduler_live`의 EventuallyFresh 통과). 그 사이 옛 내용이 검색되고 메모 재처리가 두 번 돈다. 커서 기반인 Notion에서는 회복되지 않는다(NC-1).
- 수정: 소스별 잠금을 잡과 /sync가 공유(이미 돌고 있으면 /sync는 409). FIX에서 통과.

#### 확인만 하고 결함으로 보지 않은 것
- 예약 잡끼리는 안 겹친다: max_instances 기본 1(위 표의 `Start("cron")`).
- 재시도는 유한하다: 모든 HTTP 경로가 `stop_after_attempt`(retry.py:83, 118; notion_collector.py:157; jira_collector.py:458, 508)를 쓰고 httpx 타임아웃 60s가 있다. `RunsTerminate` 통과. 단 재시도 3회가 서킷 브레이커 안에서 돌아(skald.py:243-255) 브레이커에는 실패 1회로만 잡히고, HALF_OPEN 프로브가 최대 약 3x60s + 대기 동안 잠금을 쥔다(1절 CB-1과 함께 볼 것).
- Notion `Retry-After`는 상한 없이 그대로 sleep한 뒤 tenacity 지수 대기를 또 더한다(notion_collector.py:73-90, 168-176). 큰 값이 오면 실행이 그만큼 길어진다. 실제 값은 확인 못 함(NEEDS-RUNTIME, 낮음).
- Skald 백엔드 429는 `Retry-After`를 무시하고 1~30초 지수 대기로 재시도한다(retry.py:36, 118-125). 낮음.
- 같은 메모를 두 실행이 동시에 처음 만들 때(둘 다 get에서 없음 → 둘 다 POST)도 실패하지 않는다: 백엔드가 고유 제약 위반 시 기존 메모를 재사용(createMemoUtils.ts:389-404, 마이그레이션 Migration20260311093000.ts:5-9). 재시도된 POST도 같은 이유로 안전하다.

---

## 4. Discord 스트리밍 편집 (`DiscordStream.tla`)

### 모델링한 것 (코드 대응)

| TLA+ 액션 | 코드 | 설명 |
| --- | --- | --- |
| `Token` | mentionHandler.ts:683-691, DiscordStreamEditor.ts:22-52 | `append`(동기) + 타이머 예약(이미 있으면 그대로) |
| `Status` | mentionHandler.ts:671-675, DiscordStreamEditor.ts:242-265 | 상태 편집을 체인에 넣고 await (`setPreview` 267-288도 같은 모양) |
| `End` | mentionHandler.ts:739-746, 715-719 | `finalize(최종/부분 답변)`: isFinalized, 타이머 취소, 최종 편집을 체인에 넣고 await |
| `TimerFire` | DiscordStreamEditor.ts:40-51 | 타이머 콜백이 `performEdit`을 체인에 넣음. 실패하면 finalize 전일 때만 다시 예약 |
| `Begin` | DiscordStreamEditor.ts:54-70, 115-121 | 체인 차례가 오면 **그 순간** 청크를 계산(finalize 뒤면 최종 텍스트, 오류 후면 빈 청크) |
| `EditMain`/`EditExtra`/`DelStale` | DiscordStreamEditor.ts:147-173, 214-225 | 본 메시지 편집 → 추가 청크 편집/답글 → 남는 청크 삭제(삭제 실패는 경고만) |
| `CallFail` | (Discord REST) | 레이트 리밋·권한·네트워크로 실패 |
| `AfterFinal`/`Fallback` | mentionHandler.ts:745-750, 445-455 | finalize가 던지면 전체 답변을 일반 메시지로 다시 보냄 |
| `Warn` | mentionHandler.ts:728-730 | 부분 답변 경로의 `responseThread.send('⚠️ ...')`. try 밖이라 실패하면 760의 catch로 감 |
| `DoShowError` | mentionHandler.ts:760-763, DiscordStreamEditor.ts:199-233 | 본 메시지를 오류로 바꾸고 추가 청크 전부 삭제. 이미 끝난 답변인지 확인하지 않음 |

내용은 추상화했다: 스트리밍 중에는 접두어 때문에 토큰 2묶음부터 청크 2개(123-145), 최종 텍스트는 `FinalChunks`개(72-113).

### 성질
- `FinalStays`: finalize가 성공한 뒤에는 본 메시지가 최종 답변이다(늦게 도착한 스트리밍 편집이 덮지 않음).
- `NoErrorOverDelivered`: 이미 전달된 답변을 오류 메시지가 덮지 않는다.
- `NoStuckStreaming`: 처리가 끝나면 본 메시지가 "⏳ 답변을 스트리밍하는 중" 상태로 남지 않는다.
- `NoStaleExtra`: 스트리밍 때 만든 추가 청크가 끝난 뒤 남지 않는다.
- `NoDuplicateAnswer`: 대체 재전송 위에 답변 사본(부분 최종본)이 또 남지 않는다.

### TLC 결과 (2026-11-03)

| cfg | 성질 | 결과 | distinct states | 시간 |
| --- | --- | --- | --- | --- |
| DiscordStream_nofail | 다섯 개 전부(REST 실패 없음) | 통과 | 815 | <1s |
| DiscordStream_stuck | NoStuckStreaming, NoDuplicateAnswer | **위반** (NoDuplicateAnswer, 깊이 10; NoStuckStreaming만 따로 돌려도 위반) | 925 | <1s |
| DiscordStream_stale | NoStaleExtra | **위반** (깊이 15) | 1,605 | <1s |
| DiscordStream_partial | FinalStays, NoErrorOverDelivered | **위반** (깊이 13) | 1,224 | <1s |
| DiscordStream_fixed | FinalStays, NoErrorOverDelivered, NoStuckStreaming, NoDuplicateAnswer | 통과 | 2,333 | <1s |

`nofail` 통과가 뜻하는 것: 모든 쓰기가 한 체인으로 직렬화되고 청크를 실행 시점에 계산하므로, finalize 직전에 시작된 스트리밍 편집이 있어도 최종 편집이 그 뒤에 실행된다. finalize는 앞서 쌓인 편집이 끝날 때까지 기다리고(55-69), 상태·미리보기 편집이 최종 답변을 덮는 순서도 없다. 길이 분할은 1900자(14) 기준이라 Discord 2000자 제한 안이다.

### 발견 사항

#### DS-1. 최종 편집이 실패하면 본 메시지가 스트리밍 상태로 남거나 답변이 두 번 보임 — 낮음, CONFIRMED
- 반례(stuck): 최종 편집이 본 메시지는 바꿨지만 두 번째 청크 답글에서 실패 → finalize가 던짐 → 대체 경로가 전체 답변을 다시 보냄. 위에는 잘린 최종본, 아래에는 전체 사본이 남는다. 첫 편집부터 실패하면 본 메시지는 "⏳ 답변을 스트리밍하는 중 ▌"로 영구히 남는다(stale trace: 남는 추가 청크도 그대로).
- 근거: DiscordStreamEditor.ts:147-161(여러 단계 비원자 쓰기), 191-196, mentionHandler.ts:745-750, 445-455.
- 수정: 대체 재전송 전에 본 메시지를 "아래에 다시 보냈습니다" 같은 짧은 문구로 바꾸고 추가 청크를 지우기(최선 노력). FIX에서 통과(정리 호출 자체는 성공한다고 가정).

#### DS-2. 남은 스트리밍 청크 삭제 실패를 경고만 하고 둠 — 낮음, CONFIRMED
- 스트리밍 중에는 접두어 때문에 최종본보다 청크가 하나 더 많을 수 있다(123-145 vs 72-113). 최종 편집에서 남는 메시지 삭제가 실패하면(165-170) 스트리밍 꼬리 조각이 답변 아래에 남는다. `stale` cfg의 NoStaleExtra 위반으로 TLC가 보여 준 가장 짧은 trace는 DS-1 경로(최종 편집 실패로 스트리밍 본 메시지와 추가 청크가 함께 남음)이고, 삭제 실패 경로(`DelStale`의 FAIL 분기)는 코드로 확인했다.
- 수정: 삭제 실패 시 그 메시지를 빈 문구로 편집 재시도. fixed cfg에는 넣지 않았다(같은 REST 실패에 다시 걸리므로 모델에서 보장 불가).

#### DS-3. 부분 답변을 전달한 뒤 경고 전송이 실패하면 답변이 오류 메시지로 지워짐 — 중간, CONFIRMED
- 반례(partial): transport_error 뒤 부분 답변으로 finalize 성공(전달됨) → `responseThread.send('⚠️ ...')`(729) 실패 → 760 catch → `showError`가 본 메시지를 "❌ Error"로 바꾸고 추가 청크를 전부 삭제(199-225). 사용자는 받은 답변을 잃는다. `showError`는 이미 끝난 답변인지 보지 않는다.
- 근거: mentionHandler.ts:715-730(728-729가 try 밖), 760-763, DiscordStreamEditor.ts:199-233(isFinalized 확인 없음).
- 영향: 백엔드가 끊긴 직후 Discord 쪽 실패(레이트 리밋 등)가 겹쳐야 한다. 같은 이유로 정상 경로에서도 대체 재전송(445-455)이 실패하면 이미 일부 보낸 뒤 오류로 바뀐다.
- 수정: 728-730을 try/catch로 감싸 비치명 처리하고, `showError`는 답변을 전달한 뒤에는 본 메시지를 건드리지 않고 별도 메시지로 알리기. FIX에서 통과.

### 일부러 모델링하지 않은 것 (2~4절)
- Notion 페이지 조회 실패(575-585: 커서 유지)와 짧은 페이지 건너뛰기(458-466): 커서를 움직이지 않으므로 생략. 단, 짧아서 건너뛴 페이지도 "skipped"로 세고 커서가 지나가므로, 나중에 내용이 길어지면 편집 시각이 갱신되어 다시 잡힌다.
- docs/release/userdata 수집기 자체의 겹침: 다른 영역(spec)에서 다룸. 여기서는 /sync 겹침의 일반형(SC-1)만 봤다.
- Discord REST의 내부 큐·레이트 리밋 재시도(discord.js): 한 호출은 성공 또는 실패로만 봤다.
- 미리보기·상태 편집 길이(PREVIEW_PREFIX + 미리보기 본문이 2000자를 넘으면 편집 실패, 287에서 로그만): 표시만 빠지고 최종 답변에는 영향이 없어 결함 목록에서 뺐다.
- 같은 사용자·스레드의 질문 직렬화(`runConversationSerially` 540-559)는 읽고 확인만 했다.
