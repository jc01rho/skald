# 메모 처리 파이프라인 TLA+ 검토 (memo 영역)

대상: origin/main 기준 `backend/` 메모 생성·수정·삭제 API, 비동기 처리 서버(RabbitMQ 소비자), stuck memo sweeper, lazy 재처리.
스펙: `MemoPipeline.tla` 하나에 상수로 시나리오를 켜고 끄며, `MemoPipeline_*.cfg`마다 한 가지 결함 또는 수정 설계를 검사한다.
아래 경로는 모두 `backend/src/` 기준이다.

## 1. 요약

| ID | 결함 | 심각도 | 분류 | 대표 cfg |
|---|---|---|---|---|
| F1 | 같은 메모를 두 소비자가 동시에 처리해 청크 세트가 두 벌 남음 | 높음 | CONFIRMED (운영 DB에서 7건 확인) | dup_lazy, reuse_race (dup_sweeper·narrow_gap은 NEEDS-RUNTIME) |
| F2 | PATCH가 커밋 전에 큐에 발행해서, 이전 내용으로 만든 청크가 `processed`로 남음 | 높음 | CONFIRMED | update_race |
| F3 | 내용 변경(PATCH/재수집) 후 발행이 실패하거나 유실되면 `processed` 상태로 낡은 청크(또는 청크 없음)가 영구히 남음 | 중간 | 재수집: CONFIRMED, PATCH 무음 유실: NEEDS-RUNTIME | reuse_lost, update_lost |
| F4 | 운영 설정(CR 꺼짐)에서 lazy 재처리가 검색·채팅에 걸린 모든 메모의 청크를 지우고 다시 처리함 | 높음 | CONFIRMED (운영에서 5042개 중 3825개가 마지막 수정 뒤 재처리됨) | lazy_waste |
| F5 | 처리 완료·오류 기록이 metadata 전체를 처리 시작 시점 스냅샷으로 덮어써서, 그 사이 사용자·수집기가 바꾼 metadata가 되돌아감 | 중간 | CONFIRMED | meta_lost |
| F6 | 항상 실패하는 메시지는 횟수 제한 없이 nack 재큐되어 무한 반복됨 | 중간 | CONFIRMED (운영 큐는 classic, 정책·DLQ 없음) | poison_live |
| F7 | sweeper는 큐에 READY 메시지가 0일 때만 돌아서, 큐가 계속 바쁘면 발행이 유실된 메모가 복구되지 않음 | 낮음 | NEEDS-RUNTIME | busy_live |
| F8 | DELETE /memo 트랜잭션 도중 처리 서버가 청크를 커밋하면 지연 FK 검사로 삭제가 500으로 실패함 | 낮음 | CONFIRMED (창은 수 ms) | delete_fail |

수정 설계(`Fix = TRUE`)는 `fixed`, `fixed_nocr`, `fixed_delete`, `fixed_live`에서 모든 안전·활성 속성을 통과한다(6절).

## 2. 모델링한 것과 코드 대응

메모 하나와 그 메모에 대한 메시지만 모델링한다. 내용은 버전 번호(`contentVer`), 청크는 `<<작성한 소비자, 읽은 내용 버전>>` 집합으로 추상화했다. 원소 하나가 한 번의 처리 실행이 쓴 부모·자식 청크와 요약 전체를 뜻하므로, 원소가 둘이면 청크 세트가 두 벌 공존한다는 뜻이다.

| 행위자 / 액션 | 코드 | 모델 |
|---|---|---|
| 생성: `received`로 커밋 후 발행 | `lib/createMemoUtils.ts:251-313`(트랜잭션), `:380-411`(발행은 커밋 뒤 `:407-409`) | `Init`, `CPublish` |
| 발행 방식 | `lib/createMemoUtils.ts:341-363`: 매번 새 연결, confirm 없는 `sendToQueue`; sweeper는 `rabbitMqConsumer.ts:136-142` | `Publish`(PublishLoss면 유실 가능) |
| 재수집(같은 reference_id/source_url) | `lib/createMemoUtils.ts:148-207`: 내용·metadata 교체 커밋, 상태·청크는 그대로; 해시가 바뀐 경우에만 발행 `:29-35`, `:387`, `:407-409` | `RCommit`, `RPublish` |
| 소비자 2개(파드 2개, prefetch 1) | `k8s/memo-processing-deployment.yaml:15`, `memoProcessingServer/rabbitMqConsumer.ts:49,101-112` | `Consumers = {c1, c2}` |
| 수신, 메시지마다 새 EM fork | `rabbitMqConsumer.ts:103-106` | `Recv` |
| `processing` 기록(EM에 메모 적재) | `processMemo.ts:104-107` → `lib/memoStatusUtils.ts:19-47` | `Start`(metadata 스냅샷 `snapMeta` 저장) |
| 내용 읽기(커밋된 것만 보임) | `processMemo.ts:22-46` | `Read` |
| 기존 청크 삭제(자동 커밋 3회) | `processMemo.ts:86-89` | `DelChunks` |
| 청크·요약 삽입(각자 flush) | `memoOperations.ts:186,235,267`, `processMemo.ts:92-99` | `Insert` |
| `processed` 기록 | `processMemo.ts:119-127` → `memoStatusUtils.ts:19-47` | `Finish` |
| 실패 → `error` 기록 → nack 재큐 | `processMemo.ts:130-153`, `rabbitMqConsumer.ts:69-85` | `Fail` |
| 메모 없음 → ack | `processMemo.ts:132-135`, `rabbitMqConsumer.ts:71-76`, `lib/errors.ts:37-39` | `Start`/`Read`의 deleted 분기 |
| 파드 크래시 → 미확인 메시지 재전달 | `rabbitMqConsumer.ts:110,116-124` | `Crash` |
| PATCH /memo | `api/memo.ts:371-438`: 트랜잭션 안에서 청크 삭제 `:408-411`, 발행 `:426-428`, 그 뒤 커밋 `:430-431` | `UBegin`, `UPublish`, `UCommit` |
| metadata 교체 | `api/memo.ts:417`, `createMemoUtils.ts:155` | `MetaWrite` |
| DELETE /memo | `api/memo.ts:558-564`(한 트랜잭션, 메모 행을 마지막에 삭제) | `DOpen`, `DMemo`, `DCommit` |
| lazy 재처리 | `lib/lazyReprocessService.ts:53-111`; 호출 `api/chat.ts:548,783`, `api/search.ts:94` | `LDelete`, `LReset`, `LPublish` |
| sweeper(파드마다 1개) | `memoProcessingServer/stuckMemoSweeper.ts:80-131`, 기동 `memoProcessingServer.ts:78-91` | `Exhaust`, `Claim`, `SPublish` |

환경 상수: `SlowProcessing`(한 번의 처리가 `MEMO_STUCK_PROCESSING_STALE_MINUTES`=120분 초과), `NarrowGap`(전달 직후 `processing` 기록 전 sweeper 실행), `PublishLoss`(발행 유실·예외), `Poison`(이 메모 처리는 항상 실패), `BusyQueue`(다른 메시지로 큐가 비지 않음), `SlowPublish`(API 쪽 발행이 커밋 뒤 10분 넘게 걸림), `CREnabled`(`CONTEXTUAL_RETRIEVAL_ENABLED`).

### 이번 검토에서 바꾼 모델 부분

이전 실행에서 `baseline`(동시 작성자 없음)이 `NoDuplicateChunks`를 위반했다. 트레이스는 생성자가 발행하기 전에 sweeper가 `received` 메모를 집어 가는 경로였다. 실제 CLAIM_SQL은 `GREATEST(created_at, updated_at) < now() - 10분`(`stuckMemoSweeper.ts:59-60`)이고 생성자는 커밋 후 수 ms 안에 발행하므로, 모델에 시간 조건이 빠져서 생긴 MODEL-ONLY 위반이다. `Claim`에 "생성·재수집·PATCH의 발행이 남아 있으면 `received` 메모를 집지 않는다"는 조건을 넣고, 이 가정을 풀어 보는 `SlowPublish` 상수를 추가했다. 수정 후 `baseline`은 통과하고, `slow_publish`는 발행이 10분 넘게 걸리는 경우에만 중복이 생김을 보여 준다.
lazy 재처리의 상태 초기화(`lazyReprocessService.ts:101-108`)는 `updated_at`을 갱신하지 않으므로 이 조건에서 빠진다. 즉 lazy로 `received`가 된 메모는 sweeper가 곧바로 집을 수 있다(F1의 한 경로).

## 3. 검사한 속성

- `NoDuplicateChunks`: 청크 세트는 최대 한 벌. 두 벌이면 검색에 같은 내용이 두 번 걸리고, 옛 내용과 새 내용이 섞일 수 있다.
- `ProcessedIsFresh`: 진행 중인 일이 없을 때 `processed`면 청크가 있고 모두 현재 내용 버전에서 나왔다. sweeper는 `processed`를 보지 않으므로 이 상태가 깨지면 영구적이다.
- `NoLostMetaUpdate`: 사용자·수집기의 metadata 쓰기는 되돌려지지 않는다.
- `NoWastedLazyReprocess`: 현재 설정으로 이미 처리된 메모의 청크를 lazy 재처리가 지우지 않는다.
- `DeletedNoChunks`: 삭제된 메모에 청크가 남지 않는다.
- `DeleteNeverFails`: 사용자의 DELETE가 백그라운드 처리 때문에 실패하지 않는다.
- 활성(약한 공정성): `EventuallyQuiet`(큐와 소비자가 결국 조용해짐), `ReceivedResolves`(`received`는 결국 `processed`/`error`/삭제로 끝남).

## 4. TLC 결과

명령(메모 폴더에서): `/usr/lib/jvm/java-21/bin/java -XX:+UseParallelGC -cp /home/whrho/.local/share/tla/tla2tools.jar tlc2.TLC -workers 4 -cleanup -deadlock -noGenerateSpecTE -metadir /tmp/<dir> MemoPipeline.tla -config MemoPipeline_<cfg>.cfg`
`-deadlock`을 쓰는 이유: 모델은 유한 상한(발행·크래시 횟수)을 다 쓰면 멈추는데, 이것은 결함이 아니라 모델의 끝이다. 활성 속성은 공정성으로 따로 검사한다.
실행 환경: linux5, Java 21, tla2tools.jar, 2026-11-03.

<!-- TLC-TABLE-BEGIN -->
| cfg | 목적 | 결과 | distinct states | 시간 |
|---|---|---|---|---|
| baseline | 원 코드, 동시 작성자 없음(크래시·일시 오류·발행 유실만) | 통과 | 476 | 1초 |
| busy_live | F7 발행 유실 + 큐가 계속 바쁨 | 위반: ReceivedResolves | 94 | 1초 |
| delete | 처리 중 삭제 후 청크 부활 여부 | 통과 | 278956 | 4초 |
| delete_fail | F8 삭제 트랜잭션 중 청크 커밋 | 위반: DeleteNeverFails | 49 | 1초 |
| dup_lazy | F1 처리 중 lazy 재처리 | 위반: NoDuplicateChunks | 2445 | 1초 |
| dup_sweeper | F1 120분 넘는 처리 중 sweeper 재발행 | 위반: NoDuplicateChunks | 248 | 1초 |
| narrow_gap | F1 전달 직후 processing 기록 전 sweeper | 위반: NoDuplicateChunks | 185 | 1초 |
| reuse_race | F1 처리 중 같은 reference_id 재수집 | 위반: NoDuplicateChunks | 796 | 0초 |
| reuse_lost | F3 재수집 발행 실패 | 위반: ProcessedIsFresh | 405 | 1초 |
| update_lost | F3 PATCH 발행 유실 | 위반: ProcessedIsFresh | 494 | 2초 |
| update_race | F2 PATCH가 커밋 전에 발행 | 위반: ProcessedIsFresh | 613 | 1초 |
| meta_lost | F5 상태 기록이 metadata 스냅샷으로 덮어씀 | 위반: NoLostMetaUpdate | 46 | 1초 |
| lazy_waste | F4 CR 꺼짐(운영값) + lazy 재처리 | 위반: NoWastedLazyReprocess | 181 | 1초 |
| poison_live | F6 독성 메시지 | 위반: EventuallyQuiet | 25 | 1초 |
| slow_publish | 모델 점검: API 발행이 10분 넘게 걸릴 때 | 위반: NoDuplicateChunks | 200 | 1초 |
| fixed | 수정 설계, CR 켬(lazy 활성) + 수정·재수집·메타·크래시·오류·느린 처리 | 통과 | 13268579 | 49초 |
| fixed_nocr | 수정 설계, CR 꺼짐 + SlowPublish | 통과 | 1229770 | 10초 |
| fixed_live | 수정 설계, 독성+유실+바쁜 큐 활성 속성 | 통과 | 15018 | 3초 |
| fixed_delete | 수정 설계, 처리·수정·lazy와 겹치는 삭제 | 통과 | 310110 | 3초 |

`fixed` 계열을 뺀 위반 행은 모두 원 코드(`Fix = FALSE`)에서 나온 것이다. 시간은 linux5에서 4개 cfg를 동시에 돌릴 때의 벽시계 시간이다.
<!-- TLC-TABLE-END -->

## 5. 발견 사항

### F1. 같은 메모를 두 소비자가 동시에 처리해 청크가 두 벌 남음 (높음, CONFIRMED)

처리 한 번은 "기존 청크 삭제(자동 커밋) → 수 분짜리 LLM·임베딩 작업 → 새 청크 삽입"이고(`processMemo.ts:86-99`, `memoOperations.ts:186,235,267`), 그 사이 메모에 잠금이나 세대 번호가 없다. 파드마다 prefetch는 1이지만 파드가 2개라(`k8s/memo-processing-deployment.yaml:15`) 같은 메모의 메시지 두 개가 동시에 처리될 수 있다. 둘 다 지우고 나서 둘 다 넣으면 두 벌이 남는다.

두 번째 메시지가 생기는 경로:
1. lazy 재처리(dup_lazy): c1이 처리 중일 때 채팅·검색이 이 메모를 참조하면, `lazyReprocessService.ts:53-64`는 상태를 보지 않고 `contextual_retrieval_applied`만 보고 `received`로 되돌린 뒤 발행한다(`:96-111`). c2가 받아서 c1과 겹친다. 채팅은 답변을 다 만든 뒤 lazy를 부르므로(`api/chat.ts:548,783`) 같은 메모를 참조한 두 요청이 거의 동시에 lazy를 부르는 것도 흔하다(api-server 2개).
   트레이스: 생성 발행 → c1 수신·processing·내용 읽기 → lazy 청크 삭제·received·발행 → c2 수신·processing → c1·c2 각자 청크 삭제 → c2 삽입 → c1 삽입 → 두 벌.
2. 재수집(reuse_race): 수집기가 같은 reference_id로 바뀐 내용을 다시 보내면 커밋 후 발행한다(`createMemoUtils.ts:148-207,407-409`). c1이 v1을 처리하는 동안 c2가 v2를 처리하면 v1과 v2 청크가 함께 남는다. 이 경우 `processed`인데 옛 내용 청크가 검색된다.
3. lazy 초기화 직후 sweeper: lazy의 UPDATE는 `updated_at`을 바꾸지 않아(`:101-108`) CLAIM_SQL의 10분 조건(`stuckMemoSweeper.ts:59-60`)을 바로 통과한다. lazy 발행 직전에 sweeper가 돌면 메시지가 두 개가 된다. 창은 발행에 걸리는 시간(새 AMQP 연결)뿐이라 드물다.
4. 120분 넘는 처리(dup_sweeper, NEEDS-RUNTIME): `processing_started_at`이 120분 지나면 sweeper가 다시 발행한다(`:61-62`). 큰 문서는 docling 처리로 오래 걸린다는 주석이 있다(`processMemo.ts:49-51`). 실제 처리 시간 분포에 달려 있다.
5. 전달 직후 sweeper(narrow_gap, NEEDS-RUNTIME): 메시지가 소비자에게 전달됐지만 아직 `processing`이 기록되기 전(수 ms)에는 READY도 0이고 상태도 `received`다(`stuckMemoSweeper.ts:99-103`, `processMemo.ts:104`). 큐에서 10분 넘게 기다린 메모일 때만 해당한다.

운영 증거(읽기 전용 조회, 2026-11-03): `skald_memoparentchunk`에서 같은 `chunk_index`가 중복된 메모가 7개 있고, 모두 부모·자식 청크가 정확히 두 배다(예: 220개 중 서로 다른 내용 110개, 자식 1120개 중 560개). 7개 모두 `processing_completed_at`이 `updated_at`보다 한참 뒤라 lazy 재처리 중에 생긴 것과 맞는다.

수정: 메모에 처리 세대(`processing_gen`)를 두고, 내용 변경·재처리 요청마다 올린다. 처리 결과는 LLM 작업을 DB 밖에서 끝낸 뒤 한 트랜잭션에서 `UPDATE skald_memo SET processing_status='processed', metadata = metadata || $patch WHERE uuid=$1 AND processing_gen=$gen`이 1행일 때만 청크를 지우고 넣는다. 0행이면 결과를 버린다. 같은 세대 메시지 두 개가 겹쳐도 마지막 트랜잭션이 통째로 교체하므로 한 벌만 남는다(`FinishFix`).

### F2. PATCH가 커밋 전에 발행함 (높음, CONFIRMED)

`api/memo.ts:426-428`에서 발행하고 `:430-431`에서 커밋한다. 큐가 한가하면 소비자가 수 ms 안에 메시지를 받아 `processMemo.ts:22-46`로 내용을 읽는데, READ COMMITTED라 아직 커밋되지 않은 새 내용은 보이지 않고 옛 내용을 읽는다. 소비자의 청크 삭제(`:87`)는 PATCH가 지운 행의 잠금을 기다렸다가 커밋 뒤에 진행되고, 결국 옛 내용으로 만든 청크와 `processed`가 남는다(update_race 트레이스: 처리 완료 → PATCH 시작·발행 → c1 수신·내용 읽기(v1) → PATCH 커밋(v2) → c1 삭제·삽입(v1) → `processed`).
또 PATCH는 `processing_status`를 바꾸지 않아 새 내용이 처리되기 전에도 화면에는 `processed`로 보인다.
지금은 F4 때문에 이 메모가 다음 검색에서 다시 처리되면서 우연히 가려질 수 있지만, F4를 고치면 옛 청크가 영구히 남는다.

수정: 내용·세대·`processing_status='received'`를 한 트랜잭션에 커밋한 뒤에 발행한다(F1의 세대 검사로 늦게 끝난 옛 실행도 버려진다).

### F3. 내용 변경 후 발행 실패·유실 시 영구 방치 (중간)

- 재수집(reuse_lost, CONFIRMED): `reuseExistingMemoForCreate`가 새 내용과 해시를 먼저 커밋하고(`createMemoUtils.ts:199-201`), 발행(`:407-409`)이 예외를 던지면(RabbitMQ 연결 실패 등) API는 오류를 돌려주지만 내용은 바뀐 채 상태는 `processed`, 청크는 옛 내용이다. 수집기가 같은 내용으로 다시 보내도 이제 해시가 같아서 `shouldEnqueueMemoProcessing`(`:29-35`)이 false를 돌려 발행하지 않는다. sweeper는 `received`/`processing`만 보므로(`stuckMemoSweeper.ts:58-63`) 복구되지 않는다. 재수집은 metadata를 통째로 바꿔 `contextual_retrieval_applied`가 사라지므로 지금은 F4의 lazy 재처리가 우연히 복구할 수 있다.
- PATCH(update_lost, NEEDS-RUNTIME): 발행이 예외를 던지면 롤백되어 괜찮다(`api/memo.ts:434-437`). 하지만 `sendToQueue`는 confirm 없이 버퍼에 넣고 바로 연결을 닫으므로(`createMemoUtils.ts:355-362`) 브로커가 재시작하는 등으로 메시지를 잃으면, 트랜잭션 안에서 이미 청크를 지운 메모(`api/memo.ts:408-411`)가 `processed`인데 청크가 하나도 없는 상태로 남는다. 같은 내용으로 다시 PATCH하면 해시가 같아서 건너뛴다(`:383-385`). 무음 유실은 브로커 동작이라 코드만으로는 확정할 수 없다.

수정: 내용 변경 트랜잭션에서 상태를 `received`로 바꾸고 세대를 올린다. 그러면 발행이 실패해도 sweeper가 10분 뒤 다시 발행한다. 가능하면 confirm channel(`createConfirmChannel` + `waitForConfirms`)을 쓴다.

### F4. CR이 꺼진 운영에서 lazy 재처리가 검색된 모든 메모를 다시 처리함 (높음, CONFIRMED)

`CONTEXTUAL_RETRIEVAL_ENABLED`는 `'true'`일 때만 켜지고(`memoOperations.ts:23`) 운영 파드에는 설정이 없다(kubectl로 api-server·memo-processing-server env 확인). 그래서 처리 완료 시 `contextual_retrieval_applied = false`가 기록된다(`processMemo.ts:124`). lazy 재처리는 기본으로 켜져 있고(`lazyReprocessService.ts:16`), 이 값이 NULL이거나 false인 메모를 골라(`:60-61`) 청크를 바로 지우고(`:96-98`, 자동 커밋) `received`로 바꾼 뒤 다시 발행한다. 결과적으로 채팅·검색에 걸린 메모는 매번 청크가 사라졌다가 몇 분 뒤 같은 내용으로 다시 만들어진다. 그동안 그 메모는 검색되지 않고, 임베딩·요약 비용이 들고, F1의 중복 경로가 계속 열린다.
트레이스(lazy_waste): 생성 → 처리 완료(CR=false) → lazy가 청크 삭제.

운영 증거: `processed` 5042개 중 `contextual_retrieval_applied=false` 4366개, NULL 676개로 모두 lazy 대상이다. 3825개가 마지막 `updated_at`보다 1시간 넘게 뒤에 처리 완료됐다. 최근 7일 처리 완료 1249건 대 수정 312건이다.

수정: CR이 켜져 있을 때만 lazy를 실행하고, 청크를 미리 지우지 말고 세대만 올려 재처리한다(처리 서버가 끝날 때 교체). 당장은 `LAZY_REPROCESS_ENABLED=false`로 끄는 것이 가장 작은 조치다.

### F5. 상태 기록이 metadata를 처리 시작 시점 스냅샷으로 덮어씀 (중간, CONFIRMED)

메시지마다 새 EM fork를 만들고(`rabbitMqConsumer.ts:105`), `processing` 기록 때 `findOne`으로 메모를 identity map에 올린다(`memoStatusUtils.ts:19`). 처리가 끝날 때 다시 `findOne`을 부르지만 MikroORM 6.5.9는 identity map에 있는 엔터티를 DB에서 다시 읽지 않고 돌려준다(`node_modules/@mikro-orm/core/EntityManager.js:536-550`). 그 낡은 객체에 `{...memo.metadata, ...updates}`를 만들어(`memoStatusUtils.ts:40-45`) flush하므로 metadata 컬럼 전체가 시작 시점 값으로 덮인다(`processMemo.ts:119-127`, 오류 경로 `:140-145`). 처리 중에 PATCH가 metadata를 바꾸거나(`api/memo.ts:417`) 재수집이 metadata(예: `source_url`, `file_hash`)를 바꾸면(`createMemoUtils.ts:155`) 그 변경이 사라진다. `file_hash`가 되돌아가면 다음 문서 업로드의 해시 비교(`createMemoUtils.ts:422-425`)도 틀어진다.
트레이스(meta_lost): c1 processing 기록(스냅샷 0) → 사용자 metadata 쓰기(1) → c1 완료 기록 → metadata 0으로 되돌아감.

수정: 상태 기록을 SQL로 바꾼다. `UPDATE skald_memo SET processing_status=?, ..., metadata = COALESCE(metadata,'{}') || ?::jsonb WHERE uuid=?`. 또는 최소한 `em.findOne(Memo, {uuid}, { refresh: true })`.

### F6. 독성 메시지 무한 재시도 (중간, CONFIRMED)

`MemoNotFoundError`/`ProjectNotFoundError`가 아닌 모든 오류는 `nack(msg, false, true)`로 바로 재큐된다(`rabbitMqConsumer.ts:79-84`, `lib/errors.ts:37-39`). 재시도 횟수나 지연이 없고, 운영 `process_memo`는 classic 큐에 정책·인자가 없다(rabbitmqctl 읽기 전용 확인). 문서 변환 실패나 입력 길이 초과처럼 항상 실패하는 메모는 소비자 하나를 계속 차지하고, 매번 LLM·docling 호출 비용을 쓰며, 상태가 `error`와 `processing` 사이를 오간다. sweeper의 EXHAUST는 stuck 표시가 있어야만 동작하는데 실패 기록이 그 표시를 지운다(`processMemo.ts:144`).
트레이스(poison_live): 처리 → 실패·재큐 → 다른 소비자 처리 → 실패·재큐 … 무한 반복(`EventuallyQuiet` 위반).

수정: 시도 횟수를 메시지 헤더나 메모 metadata에 세어 상한을 넘으면 ack하고 `error`로 남긴다(또는 DLX/quorum 큐 `x-delivery-limit`). 재시도에 지연을 둔다.

### F7. sweeper가 큐가 한가할 때만 동작함 (낮음, NEEDS-RUNTIME)

`stuckMemoSweeper.ts:99-103`은 READY 메시지가 하나라도 있으면 재발행(CLAIM)을 건너뛴다. 발행이 유실된 메모는 큐가 한 번이라도 비어야 복구된다. 큐가 계속 바쁘면(busy_live) `received`가 끝나지 않고, CLAIM이 없으면 stuck 표시도 생기지 않아 72시간 EXHAUST도 동작하지 않는다(`:43-52`). 운영 큐는 대개 비어 있어(조회 시점 READY 0) 실제 영향은 큐 부하에 달려 있다.

수정: 큐 유휴 조건을 없애거나, 오래된 메모부터 소량씩은 항상 집게 한다(F1의 세대 검사가 있으면 중복 메시지는 무해하다).

### F8. 처리 중 DELETE /memo가 지연 FK 검사로 실패함 (낮음, CONFIRMED)

DELETE는 한 트랜잭션에서 내용·요약·태그·자식 청크를 지우고 마지막에 메모 행을 지운다(`api/memo.ts:558-564`). 자식 청크의 `memo_id` FK는 `DEFERRABLE INITIALLY DEFERRED`이고 ON DELETE 동작이 없다(`migrations/Migration20251029191931.ts:247`, `entities/MemoChunk.ts:30-36`). 자식 청크를 지운 뒤 메모 행을 지우기 전에 처리 서버가 새 청크를 커밋하면(메모 행은 아직 살아 있어 그쪽 FK 검사는 통과), DELETE 트랜잭션은 커밋할 때 FK 위반으로 롤백되고 사용자는 500을 받는다. 창이 두 SQL 사이 수 ms라 드물고, 다시 지우면 성공한다.
트레이스(delete_fail): 삭제 트랜잭션 시작(청크 삭제) → 처리 서버 청크 삽입·커밋 → 메모 행 삭제 → 커밋 실패.

수정: 트랜잭션 첫 문장으로 메모 행을 `SELECT ... FOR UPDATE`하거나 먼저 지운다. 또는 `skald_memochunk.memo_id`를 부모 청크처럼 `ON DELETE CASCADE`로 바꾼다(`Migration20260112100000.ts:31-37`).

### 문제가 아니었던 것

- `delete` cfg: 처리·수정·lazy 도중 삭제해도 삭제된 메모에 청크가 되살아나지 않는다(`DeletedNoChunks` 통과). 처리 서버의 청크 삽입은 커밋 시 FK 검사가 삭제된 메모 행에서 실패하고, 그 뒤 재전달 메시지는 `MemoNotFoundError`로 ack된다.
- `baseline`: 동시 작성자 없이 크래시·일시 오류·생성 발행 유실만 있으면 sweeper가 복구하고 모든 속성을 통과한다.
- `slow_publish`(MODEL-ONLY 점검): 생성 직후 sweeper가 발행 전에 메모를 집는 경로는 발행이 10분 넘게 걸릴 때만 가능하다. 일반 운영에서는 일어나지 않는다고 본다.

## 6. 수정 설계와 검증

`Fix = TRUE`일 때 모델은 다음 설계를 따른다.
1. 내용 변경(PATCH, 재수집)과 lazy 재처리는 한 트랜잭션에서 내용, `processing_gen + 1`, `processing_status='received'`를 커밋한 뒤 발행한다(`UBegin`, `RCommit`, `LDelete`의 Fix 분기).
2. 처리 서버는 시작 시 세대를 기억하고, LLM 작업이 끝난 뒤 한 트랜잭션에서 세대가 같을 때만 청크를 통째로 교체하고 `processed`와 metadata 병합(`||`)을 기록한다(`FinishFix`). 이미 `processed`인 메모의 메시지는 낡은 것으로 보고 ack한다(`Start`).
3. 실패는 `MaxAttempts`까지만 재큐하고 그 뒤로는 ack한다(`Fail`).
4. sweeper는 큐 유휴 여부와 관계없이 집는다(`Claim`).
5. lazy 재처리는 CR이 켜져 있을 때만, 청크를 지우지 않고 세대만 올린다.
6. DELETE는 메모 행을 먼저 잠그거나 지운다(`DOpen`).

결과는 4절 표의 `fixed`, `fixed_nocr`, `fixed_delete`, `fixed_live` 행이다. 모든 안전 속성과 `EventuallyQuiet`, `ReceivedResolves`를 통과한다.

## 7. 일부러 모델링하지 않은 것

- 메모 여러 개: 메시지 순서나 메모 간 간섭은 다루지 않았다. 큐가 바쁜 상황은 `BusyQueue` 하나로 추상화했다.
- 시간: 10분·120분·72시간 조건은 `NarrowGap`, `SlowProcessing`, `SlowPublish`, "결국"으로만 표현했다.
- 위키 갱신(`processMemo.ts:111-117`): 실패 원인 중 하나로만 다루고 위키 쪽 상태는 wiki 영역에서 본다.
- 문서 메모의 S3 업로드(`createMemoUtils.ts:446-451`)와 docling 변환 결과의 `MemoContent` 생성(`processMemo.ts:48-75`). 문서 메모가 두 번 처리되면 `MemoContent`가 두 행 생길 수 있어 보이지만 모델링하지 않았다(NEEDS-RUNTIME).
- Redis·SQS 모드(`memoProcessingServer.ts:60-73`): 운영은 rabbitmq(`INTER_PROCESS_QUEUE=rabbitmq` 확인). SQS 소비자는 실패 시 메시지를 지우고 DLQ로 보내므로(`sqsConsumer.ts:32-43`) F6이 없다.
- 생성 경로의 unique 위반 재조회(`createMemoUtils.ts:389-404`): 같은 reference_id 동시 생성은 재수집 경로로 합쳐지므로 `RCommit`으로 대표했다.
- PATCH가 `DI.memoContents`(전역 EM)로 읽은 엔터티를 fork EM에 persist하는 부분(`api/memo.ts:390-393`)은 동시성 문제가 아니라서 다루지 않았다.

## 8. 운영 확인에 쓴 읽기 전용 명령

- env: `kubectl -n skald exec deploy/<api-server|memo-processing-server> -- printenv`(CONTEXTUAL/LAZY/MEMO_STUCK 미설정, INTER_PROCESS_QUEUE=rabbitmq)
- 큐: `kubectl -n skald exec rabbitmq-0 -- rabbitmqctl list_policies` / `list_queues name type durable messages_ready messages_unacknowledged consumers arguments`
- DB: `kubectl -n skald exec -i postgres-0 -- psql ... -f -`에 `BEGIN READ ONLY; ...; ROLLBACK;`로 상태·CR 분포, 중복 `chunk_index`, `processing_completed_at > updated_at` 개수를 조회
