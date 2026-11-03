# wiki 영역 TLA+ 검토 (위키 새로고침 큐와 컴파일러)

대상: 메모 처리 뒤 위키 새로고침 요청을 만들고(`processMemo.ts:111-117`, `WikiCompilerService.enqueueRefreshForMemo`), 위키 처리 서버가 그 요청을 받아(`wikiProcessingServer/rabbitMqConsumer.ts`) 컴파일해 WikiPage/Revision/Claim을 쓰는 흐름(`services/wiki/wikiCompilerService.ts`).
소스 기준: 워크트리 `/home/whrho/git/skald-wt/tla-review`(origin/main `acb7241`). 애플리케이션 코드는 바꾸지 않았다.
명세: `WikiRefresh.tla`(488줄). 결함 재현은 `Fixes = {}`(또는 일부), 수정 설계는 `Fixes`에 수정 이름을 넣어 검사한다.

실행 명령(이 폴더에서):

```
java -XX:+UseParallelGC -cp ~/.local/share/tla/tla2tools.jar tlc2.TLC -workers 4 -cleanup -deadlock \
  -noGenerateSpecTE -metadir /tmp/tlc/<cfg> WikiRefresh.tla -config WR_<cfg>.cfg
```

## 1. 모델과 코드 대응

| 액션 | 코드 | 설명 |
| --- | --- | --- |
| `UserUpdate` / 메모 처리 | `processMemo.ts:111-117`, `wikiCompilerService.ts:243-305` | 원문 동기화(`syncRawSourceFromMemo`, 해시가 처음 보는 값일 때만 새 RawSourceContent, `:211-222`) 뒤 요청 생성. 열린 요청이 있으면(상태 pending·claimed·processing, `:258-262`) 새 요청 없이 그 행의 metadata만 고침(`:276-288`) |
| `UserDelete` | `api/memo.ts:557-563` | 메모 삭제 트랜잭션이 Content/Summary/Tag/Chunk/Memo만 지움. 위키 원문·claim·요청은 그대로 |
| `Batch` | `wikiCompilerService.ts:319-370` | 오래된 요청 정리 후 pending 조회 |
| `Claim` | `:374-407` | 문서별 가장 오래된 pending을 claimed로, 나머지는 completed. `em.flush()`는 조건 없는 UPDATE |
| `Start` | `:431-446` | `findOne` 뒤 상태가 pending **또는 claimed**면 받아들이고(`:437`) claim_token을 확인하지 않은 채 processing으로 flush(`:440-446`) |
| `Read` | `:471-475` | 최신 RawSourceContent(created_at DESC) |
| `Commit` | `:680-685`, `:789-796` | claim은 INSERT만 함(삭제 없음), 마지막 flush에서 completed |
| `LlmFail` | `:797-807` | 실패면 failed. 실패 요청을 다시 큐에 넣는 경로 없음 |
| `Ack/Nack` | `rabbitMqConsumer.ts:44`, `:47` | 처리 예외면 `nack(msg,false,true)` 재큐 |
| `Crash` | (k8s 파드 종료) | unacked 메시지는 재전달, 이미 만든 WikiCompileRun은 processing으로 남음 |
| `Sweep` | 없음 | `batch_tick` 메시지는 수동 스크립트(`scripts/backfillWikiForMemos.ts:136`)만 보냄 |

## 2. 속성

| 이름 | 의미 |
| --- | --- |
| `NoDoubleCommit` | 한 요청의 컴파일 결과는 최대 한 번만 커밋 |
| `QuiescentFresh` | 시스템이 한가하면 위키는 메모의 현재 내용을 반영 |
| `QuiescentNoStaleClaims` | 한가하면 claim은 살아 있는 메모의 현재 내용에 대해서만 존재 |
| `QuiescentNoStuck` | 한가하면 열린 새로고침 요청이 없음 |
| `QuiescentNoOrphanRun` | 한가하면 processing으로 남은 WikiCompileRun이 없음 |

## 3. TLC 결과 (2026-11-03, linux5)

| cfg | 결과 | distinct states | depth | 시간 |
| --- | --- | ---: | ---: | ---: |
| `WR_claimrace` | 위반: NoDoubleCommit | 247 | 19 | 0.7s |
| `WR_stale` | 위반: NoDoubleCommit | 315 | 18 | 0.7s |
| `WR_lostupdate` | 위반: QuiescentFresh | 73 | 22 | 0.7s |
| `WR_revert` | 위반: QuiescentFresh | 300 | 24 | 0.7s |
| `WR_claims` | 위반: QuiescentNoStaleClaims | 84 | 22 | 0.7s |
| `WR_delete` | 위반: QuiescentNoStaleClaims | 25 | 12 | 0.7s |
| `WR_delete_stuck` | 통과 | 25 | 12 | 0.6s |
| `WR_crash` | 위반: QuiescentNoStuck | 42 | 13 | 0.6s |
| `WR_failed` | 위반: QuiescentFresh | 13 | 11 | 0.7s |
| `WR_publishfail` | 위반: QuiescentNoStuck | 13 | 11 | 0.8s |
| `WR_orphanrun` | 위반: QuiescentNoOrphanRun | 271 | 24 | 0.9s |
| `WR_fixed` | 통과 | 59,431 | 47 | 1.4s |
| `WR_fixed_faults` | 통과 | 115,744 | 48 | 1.4s |

위반 행의 상태 수는 처음 위반을 찾은 시점까지 센 값이라 실행마다 조금 다를 수 있다. `WR_fixed_big`(상한을 키운 수정 설계)은 탐색 공간이 커서 이번 표에 넣지 않았다.

## 4. 발견 사항

### W1. 같은 요청을 두 작업자가 동시에 컴파일해 결과가 두 번 커밋됨 (중간, CONFIRMED)
- cfg: `WR_claimrace`, `WR_stale`
- 반례: 요청 메시지가 재전달되거나 `batch_tick`이 겹쳐 두 작업자가 같은 요청을 받는다. `Start`는 상태가 pending이나 claimed이기만 하면 통과시키고(`wikiCompilerService.ts:437`) claim_token을 비교하지 않으며, processing 기록도 조건 없는 flush다(`:440-446`). 그래서 둘 다 LLM 컴파일을 하고 둘 다 리비전을 쓴다. `WR_stale`은 claimCAS를 넣어도 처리가 오래 걸려 stale 정리가 끼면 같은 일이 생긴다.
- 영향: LLM 비용이 두 배이고 리비전과 claim이 두 벌 생긴다. 같은 버전 번호로 부딪히면 23505로 실패하고 nack 재큐된다.
- 수정: 상태 전이를 `UPDATE ... SET status='processing' WHERE uuid=? AND status='claimed' AND claim_token=?`로 바꾸고, 마지막 커밋도 `WHERE claim_token=? AND status='processing'`으로 조건을 단다(claimCAS, commitCAS).

### W2. 컴파일 중에 메모가 바뀌면 새 내용이 위키에 영영 반영되지 않음 (높음, CONFIRMED)
- cfg: `WR_lostupdate`
- 반례: 요청 r1이 처리 중(claimed 또는 processing)일 때 메모가 B로 바뀐다. 새 요청을 만들지 않고 열린 r1의 metadata만 고친다(`:258-262`, `:276-288`). r1은 이미 A를 읽었으므로 A로 커밋하고 completed가 된다. B를 위한 요청은 남지 않는다.
- 영향: 메모를 고쳐도 위키와 위키 기반 답변이 옛 내용으로 남는다. 다음 수정이 있을 때까지 복구되지 않는다.
- 수정: 열린 요청 재사용은 pending일 때만 하고, claimed·processing이면 새 pending 요청을 만든다(enqueueNew). 커밋 때 읽은 내용이 최신 원문인지 다시 확인해 아니면 결과를 버린다(freshCommit).

### W3. 메모를 이전 내용으로 되돌리면 위키는 중간 내용에 머무름 (중간, CONFIRMED)
- cfg: `WR_revert`
- 반례: 내용이 A에서 B로, 다시 A로 바뀐다. 원문은 해시를 이미 본 적이 있으면 새 행을 만들지 않으므로(`:211-222`) 최신 원문 행은 여전히 B이고, 요청도 `isNewContent`가 거짓이라 새로 생기지 않는다(`:269`). 위키는 B로 남는다.
- 수정: "처음 보는 해시"가 아니라 "가장 최근 원문과 다른 해시"일 때 새 행을 만든다(latestContent).

### W4. claim이 누적만 되고 지워지지 않음, 메모 삭제 뒤에도 남음 (중간, CONFIRMED)
- cfg: `WR_claims`, `WR_delete`
- 근거: 커밋은 claim을 INSERT만 한다(`:680-685`). 내용이 바뀌어도 옛 내용의 claim이 그대로 있고, 메모 삭제(`api/memo.ts:557-563`)는 위키 원문·claim·요청을 지우지 않는다.
- 영향: 위키 페이지와 그래프가 지워졌거나 바뀐 사실을 계속 보여 준다.
- 수정: 커밋 때 이 원문 문서의 이전 claim을 같은 트랜잭션에서 교체하고(replaceClaims), 메모 삭제 트랜잭션에서 그 문서의 claim과 열린 요청을 함께 정리한다(deleteCleanup).

### W5. 작업자가 죽거나 발행이 실패하면 요청이 열린 채 남고 다시 시도되지 않음 (중간, CONFIRMED)
- cfg: `WR_crash`, `WR_publishfail`, `WR_orphanrun`
- 근거: 파드가 죽으면 메시지는 재전달되지만, 그 사이 stale 정리로 상태가 바뀐 요청은 다시 깨울 메시지가 없다. 요청 행은 커밋된 뒤 발행되므로(`processMemo.ts:113-114`) 발행이 실패하면 pending 행만 남는다. 주기적으로 `batch_tick`을 보내는 스케줄러가 없다(`batch_tick`은 수동 백필 스크립트만 보냄). `Start`가 만든 WikiCompileRun은 크래시하면 processing으로 영원히 남는다.
- 수정: 주기적 `batch_tick` 발행기를 두고(sweeper), 정리 단계에서 오래된 processing 실행 행도 failed로 마감한다(runCleanup).

### W6. 한 번 실패한 요청은 다시 시도되지 않음 (낮음, CONFIRMED)
- cfg: `WR_failed`
- 근거: LLM 오류 시 failed로 기록하고 끝난다(`:797-807`). 내용이 같으면 enqueue도 다시 하지 않는다(`:269`).
- 수정: 실패 요청을 재시도 횟수 상한과 함께 pending으로 되돌린다(retryFailed).

### 문제가 아니었던 것
- `WR_delete_stuck`: 메모 삭제 뒤 남은 요청은 커밋 단계의 지연 FK 위반(23503)으로 catch에서 failed가 되어(`:797-807`) 열린 채 남지 않는다. 이전 체크포인트에서 의심했던 정체는 `Start`를 findOne과 flush 두 단계로 나눈 뒤 재현되지 않았다(MODEL-ONLY). 삭제 뒤 claim이 남는 문제는 W4로 따로 남는다.

## 5. 수정 설계 검증

`WR_fixed`(작업자 2, 수정 1회, 요청 3, 느린 처리 포함)와 `WR_fixed_faults`(크래시·LLM 실패·발행 실패·삭제 포함)에 claimCAS, commitCAS, freshCommit, enqueueNew, latestContent, replaceClaims, deleteCleanup, retryFailed, sweeper, republish, pageLock, runCleanup을 넣으면 다섯 속성이 모두 통과한다.

## 6. 일부러 모델링하지 않은 것

- RAG 캐시(`lib/ragCache.ts`)의 무효화 순서. 이번 작업에서는 명세를 만들지 못했다. 후속 검토 대상이다.
- LLM 출력 내용, 노드·엣지 병합 규칙, 공개 위키 조회 API(읽기 전용이라 상태 전이가 없음).
- 여러 원문 문서가 한 페이지를 공유할 때의 페이지 단위 경합은 `pageLock` 수정으로만 다뤘다.
