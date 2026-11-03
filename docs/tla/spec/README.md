# spec 영역 TLA+ 검토 (명세 생명주기, 승격, 리비전)

대상: SPMS 기능 명세의 authoritative 재조정(worker), 재조정 manifest 접수와 lifecycle 증거(backend), 승격 상태기계, stage-and-publish 리비전 게시.
소스 기준: worktree `/home/whrho/git/skald-wt/tla-review` (origin/main, `acb7241`). 애플리케이션 코드는 수정하지 않았습니다.
운영 근거는 2026-11-03에 읽기 전용 SELECT와 워커 상태 파일 읽기로만 확인했습니다(쓰기 없음).

실행 명령 (모든 cfg 공통, `docs/tla/spec`에서):

```
/usr/lib/jvm/java-21/bin/java -XX:+UseParallelGC -cp /home/whrho/.local/share/tla/tla2tools.jar tlc2.TLC \
  -workers 4 -cleanup -deadlock -noGenerateSpecTE -metadir /tmp/tlc-spec/<cfg> <Spec>.tla -config <cfg>.cfg
```

`-noGenerateSpecTE`는 위반 시 `*_TTrace_*.tla`가 작업 트리에 생기지 않게 하려고 넣었습니다.

## 1. 모델과 코드 매핑

| 모델 | 다루는 것 | 핵심 코드 |
| --- | --- | --- |
| `SpecPromotion.tla` | 승격 상태기계(shadow → canary → promoted), clean 횟수 2 상한, 30분 간격, 비정상 실행 리셋, 재전송(replay), 순서 뒤바뀜, 품질 증거 | `backend/src/entities/SpecPromotionState.ts:125-165`, `specLifecycleService.ts:218-296`(advisory lock :220, replay :225-234), `SpecReconciliationRun.ts:71-84`, 품질 :464-561, 기능 노출 `SpecPromotionState.ts:118-121` |
| `SpecReconcile.tla` | 워커 재조정 1회 = 엔드포인트 F(functions/information) → T(techs/troubleshoots) → manifest 제출. 워커 로컬 상태(snapshot, absence 횟수)와 백엔드 lifecycle 상태, 승격 횟수. H1~H4 | `worker/.../collectors/docs_collector.py:896-1188`, `sync_state.py:272-419`, `backend/src/services/specLifecycleService.ts:218-426`, `backend/src/api/specLifecycle.ts:15-55` |
| `ConcurrentRuns.tla` | 같은 워커 파드에서 수동 `/sync`와 예약 재조정이 겹칠 때(H5) | `api/routes.py:300-305`, `scheduler.py:99-108, 313-319`, `docs_collector.py:906-991`, `sync_state.py:272-349` |
| `PublishRace.tla` | stage-and-publish: 증분 docs_sync와 재조정의 게시 경합, 같은 함수 코드를 가진 두 스펙의 메모 공유 | `backend/src/services/specRevisionService.ts:354-664`, `docs_collector.py:745, 798-833, 966-972, 1151`, `scheduler.py:297-319` |

### 1.1 `SpecReconcile.tla` 액션 대응

| 액션 | 코드 | 설명 |
| --- | --- | --- |
| `Toggle(k)` | (환경) | SPMS completed 목록에서 항목이 빠지거나(deprecated/삭제) 다시 생김 |
| `Start` | `docs_collector.py:906-926` | 엔드포인트마다 새 run_id |
| `Ep(e)` | `docs_collector.py:930-1049` | 마지막 페이지까지 열거(:933-977), `finish_authoritative_reconciliation`(`sync_state.py:336-419`)가 snapshot·absence 횟수를 바꾸고 **즉시 save**(:419), 증거 생성(:992-1045), exact refetch `checked_at`(:1005, :1009), save(:1048). 페이지 오류면 `finish(complete=False)`(:350-358) |
| `Submit` | `docs_collector.py:1069-1167`, `specLifecycleService.ts:218-426` | `completed_at`은 네 엔드포인트가 다 끝난 뒤(:1075). 전체가 complete가 아니면 증거를 버림(:1161). 백엔드는 한 트랜잭션에서 메모 조회(:299-311, 못 찾으면 404로 전부 롤백), 인증서 15분 창(:41), tombstone(:352-358). zod `lifecycle_evidence.max(5000)`(`specLifecycle.ts:54`) |

추상화: SPMS 항목은 키 두 개(F 쪽 `f1`, T 쪽 `t1`), absence 횟수는 0/1/2(2 = 후보), grace(48h)와 최소 간격(24h)은 "서로 다른 날의 실행"이면 충족된다고 봤습니다. 백엔드 tombstone은 "이전에 absent 기록이 있고 인증서가 있으면"으로 줄였습니다. 승격 30분 간격은 일일 실행이면 충족되므로 이 모델에서는 생략하고 `SpecPromotion.tla`에서 따로 검사했습니다.

### 1.2 플래그 (버그 재현과 수정안)

| 플래그 | TRUE일 때 의미 |
| --- | --- |
| `KEY_BUG` | (현재 코드) T 쪽 lifecycle 키 `spms:tech:<id>`가 메모 키 `spms:techs:<id>`와 달라 백엔드가 메모를 못 찾음 |
| `COMMIT_FIRST` | (현재 코드) 워커 로컬 상태를 manifest 접수 전에 확정. FALSE = 접수 영수증을 받은 뒤 확정(수정안) |
| `SLOW` | F 엔드포인트가 끝난 뒤 나머지 엔드포인트가 15분 넘게 걸림(운영 실측 31분) |
| `FIX_CERT` | (수정안) exact refetch와 `checked_at`을 제출 직전에 수행 |
| `PRUNE` | (수정안) 백엔드가 tombstone한 키는 absent 증거를 다시 보내지 않음 |

## 2. 속성

| 모델 | 속성 | 의미 |
| --- | --- | --- |
| SpecPromotion | `StateMatchesCount` | 상태와 clean 횟수가 일치 |
| | `PromotedSound` | promoted면 서로 다른 clean 실행 두 개가 30분 이상 간격으로 존재 |
| | `OlderFailureDoesNotDemote` (행동) | 마지막 clean보다 먼저 끝난 비정상 실행이 늦게 도착해도 강등하지 않음 |
| | `QualitySticky` (행동) | promoted가 유지되는 동안 기록된 품질 증거가 지워지지 않음 |
| SpecReconcile | `QuarantineConsistent` | complete manifest가 접수된 뒤, 그 실행에서 SPMS에 있던 항목은 Skald에서 quarantined/tombstoned가 아님 |
| | `PromotionNotStale` | 연속 2회 이상 manifest가 영구 거절되는 동안 promoted로 남지 않음 |
| | `EvidenceOnlyLive` | 이미 tombstone된 메모에 대해 absent 증거를 다시 보내지 않음 |
| | `AcceptedInfinitelyOften` (liveness, WF) | SPMS 변화와 일시 장애가 멈추면 complete manifest가 계속 접수됨 |
| ConcurrentRuns | `NoCrash` | 다른 실행이 진행 중이라는 이유로 요청이 내부 오류로 끝나지 않음 |
| | `SnapshotComplete` | 성공한 실행의 snapshot은 SPMS 전체 |
| PublishRace | `NoSpuriousDrift` | 같은 항목의 더 새 리비전에 게시 경합으로 진 것을 drift로 세지 않음 |
| | `MemoMatchesSource` | 게시된 스펙의 메모는 그 스펙의 내용을 담음 |

## 3. TLC 결과 (2026-11-03 실행)

| spec | cfg | 결과 | distinct states | depth | 시간 |
| --- | --- | --- | --- | --- | --- |
| `SpecPromotion` | `SP_base` | 통과 | 5240 | 9 | 0.5s |
| `SpecPromotion` | `SP_order` | **위반** (OlderFailureDoesNotDemote) | 1677 | 7 | 0.4s |
| `SpecPromotion` | `SP_quality` | **위반** (QualitySticky) | 4949 | 9 | 0.8s |
| `SpecReconcile` | `SR_h1_live` | **위반** (AcceptedInfinitelyOften) | 63 | 21 | 0.3s |
| `SpecReconcile` | `SR_h1_stale` | **위반** (PromotionNotStale) | 49 | 14 | 0.3s |
| `SpecReconcile` | `SR_h1_fixed` | 통과 | 48 | 14 | 0.6s |
| `SpecReconcile` | `SR_h2` | **위반** (QuarantineConsistent) | 1949 | 17 | 0.4s |
| `SpecReconcile` | `SR_h2_fixed` | 통과 | 2092 | 23 | 0.6s |
| `SpecReconcile` | `SR_h3` | **위반** (AcceptedInfinitelyOften) | 55 | 21 | 0.3s |
| `SpecReconcile` | `SR_h3_fixed` | 통과 | 48 | 14 | 0.4s |
| `SpecReconcile` | `SR_h4` | **위반** (EvidenceOnlyLive) | 46 | 13 | 0.3s |
| `SpecReconcile` | `SR_h4_cap` | **위반** (AcceptedInfinitelyOften) | 210 | 26 | 0.4s |
| `SpecReconcile` | `SR_h4_fixed` | 통과 | 159 | 15 | 0.5s |
| `SpecReconcile` | `SR_fixed` (수정안 전부, SLOW=TRUE, 일시 장애 포함) | 통과 | 2152 | 23 | 0.5s |
| `ConcurrentRuns` | `CR_race` | **위반** (NoCrash) | 78 | 11 | 0.3s |
| `ConcurrentRuns` | `CR_fixed` | 통과 | 43 | 15 | 0.3s |
| `PublishRace` | `PR_stale` | **위반** (NoSpuriousDrift) | 35 | 6 | 0.3s |
| `PublishRace` | `PR_shared` | **위반** (MemoMatchesSource) | 47 | 5 | 0.2s |
| `PublishRace` | `PR_fixed` | 통과 | 531 | 10 | 0.3s |

같은 명령으로 전체를 한 번 더 돌려 통과/위반이 모두 같게 나오는 것을 확인했습니다. 통과 실행의 상태 수는 매번 같고, 위반 실행은 워커 4개가 처음 위반을 찾는 시점에 따라 상태 수가 조금씩 달라집니다(예: `SP_order` 1677/1451).

## 4. 가설 판정 요약

| 가설 | 판정 | 근거 |
| --- | --- | --- |
| H1 tech/troubleshoot 키 불일치 → 404 반복 → 영구 정체 | **확인(CONFIRMED, 잠복)** | 코드와 운영 데이터 모두 일치. 아직 tech/troubleshoot가 SPMS에서 빠진 적이 없어 발동 전 (F1) |
| H2 manifest 제출 전에 로컬 snapshot 전진 | **확인(CONFIRMED)** | `sync_state.py:419`, `docs_collector.py:1048`이 `:1164` 제출보다 먼저. 전체 incomplete면 증거만 버림 `:1161` (F3) |
| H3 엔드포인트별 `checked_at` vs 최상위 `completed_at` 15분 창 | **확인(CONFIRMED, 잠복)** | 운영 실측: functions 종료 05:55:09, manifest `completed_at` 06:26:37(31분) (F2) |
| H4 absence 증거 무제한 vs zod 5000 | **확인(CONFIRMED), 상한 도달은 먼 미래** | tombstone된 키도 매 실행 재전송(운영: 2키 32건). 현재 1회 72건 (F5) |
| H5 수동 + 예약 동시 실행 → run mismatch | **확인(CONFIRMED)** | 공유 `reconciliation_run_id`에 합류한 뒤 먼저 끝난 쪽이 run을 지우면 남은 쪽이 `ValueError`. 두 실행만으로는 "No authoritative reconciliation is active"가, 세 번째 시작이 끼면 "Reconciliation run mismatch"가 남 (F6) |
| 승격 상태기계 | 핵심 규칙은 **안전**(`SP_base` 통과). 순서 뒤바뀜 강등은 MODEL-ONLY, 품질 증거 소거는 설계상 동작 (F9, F10) |
| stage-and-publish 동시성 | advisory lock으로 같은 스펙 게시는 직렬화되어 안전. 대신 두 가지 결함: 함수 코드 중복 시 메모 공유(F8, CONFIRMED·운영 1건), 증분/재조정 경합 시 가짜 drift(F7, NEEDS-RUNTIME) |

## 5. 발견 사항

### F1. tech/troubleshoot 항목이 SPMS에서 빠지면 재조정이 영구히 거절됨 (H1)
- 심각도: **high** / 분류: **CONFIRMED** (잠복, 발동 조건: tech 또는 troubleshoot 하나가 SPMS 목록에서 빠짐)
- 트레이스(`SR_h1_live`): `t1` 제거 → 실행 1의 T 엔드포인트가 `spms:tech:t1` absent 증거를 만듦 → 백엔드 404 `MEMO_NOT_FOUND`, 트랜잭션 전체 롤백 → 워커 로컬 absence는 이미 저장됨 → 다음 실행도 같은 증거(후보가 되면 인증서까지) → 404 … 같은 상태로 무한 반복(TLC lasso). `SR_h1_stale`: 그동안 승격 상태는 promoted 그대로.
- 코드 근거:
  - lifecycle 키: `docs_collector.py:954-959` `source_type = endpoint_type[:-1]` → `spms:tech:<id>`, `spms:troubleshoot:<id>`.
  - 메모 키: techs/troubleshoots는 `sync_item(detail, "techs")`(:968)에서 `upsert_memo(reference_id=build_reference_id(item, "techs"))`(:827-833) → `spms:techs:<id>`(:662-668). 메모 생성 시 `client_reference_id = reference_id`(`backend/src/lib/createMemoUtils.ts:261`).
  - 백엔드 조회: `client_reference_id = ?` 또는 `skald_spec_source.spec_id = ?`(`specLifecycleService.ts:299-311`). techs/troubleshoots는 stage-and-publish 대상이 아니라(`docs_collector.py:824`) `skald_spec_source` 행이 없음 → `rows.length !== 1` → 404.
  - 404가 트랜잭션(`:219`) 안에서 던져져 run 행과 승격 갱신도 롤백. 워커는 `record_sync_failure`만 하고(:1165-1167) 로컬 absence는 유지.
- 운영 확인(읽기 전용, 2026-11-03): `skald_memo.client_reference_id` 접두어가 `spms:techs` 44, `spms:troubleshoots` 292이고 `spms:tech:`·`spms:troubleshoot:`는 0건. lifecycle 이벤트에도 tech/troubleshoot 키는 아직 없음(발동 전).
- 기존 수정 `2133d72`(function 메모를 `skald_spec_source`로 찾기)는 functions/information만 고쳤고 techs/troubleshoots는 여전히 해당합니다.
- 수정안: 워커가 lifecycle `memo_reference_id`를 메모 키와 같은 규칙(`build_reference_id(item, endpoint_type)`)으로 만들거나, 백엔드 조회에 `spms:<type>s:<id>` 별칭을 추가. 장기적으로는 증거마다 게시 영수증의 `memo_reference_id`를 쓰는 편이 안전합니다. `SR_h1_fixed` 통과.

### F2. 함수(또는 tech)가 실제 삭제되면 exact-refetch 인증서가 항상 만료로 거절됨 (H3)
- 심각도: **high** / 분류: **CONFIRMED** (잠복, 발동 조건: functions 또는 techs 항목이 SPMS에서 404가 되고 grace 48h가 지남)
- 트레이스(`SR_h3`): `f1` 제거 → 실행 1 quarantined 접수 → 실행 2에서 후보가 되어 F 엔드포인트 직후 인증서 발급 → 나머지 엔드포인트가 15분 넘게 걸림 → 백엔드 400 `INVALID_REFETCH_CERTIFICATE`(stale) → 다음 실행도 같은 인증서 → 무한 반복.
- 코드 근거: `checked_at`은 엔드포인트 하나가 끝난 직후(`docs_collector.py:1005`, refetch :1009). 묶을 때 run_id만 바꾸고 `checked_at`은 그대로(:1095-1112). `completed_at`은 네 엔드포인트 종료 뒤(:1075). 백엔드는 `|completed_at - checked_at| > 15분`이면 거절(`specLifecycleService.ts:41-43`), 그러면 F1과 같이 전체 롤백.
- 운영 실측(워커 상태 파일, 2026-11-03 실행): functions `completed 05:55:09`, techs `05:55:19`, information `06:25:45`, manifest `completed_at 06:26:37`. functions·techs 인증서는 31분 차이로 반드시 만료됩니다. information(종료 후 52초)과 troubleshoots는 통과하므로 지금까지 information 2건이 tombstone될 수 있었던 것과 일치합니다. 현재 function absence 26건은 refetch가 present(deprecated 상태로 상세가 남음)라 인증서가 없어 아직 발동하지 않았습니다.
- 수정안: absence 후보의 exact refetch를 네 엔드포인트가 끝난 뒤 제출 직전에 한 번에 수행(`checked_at`이 `completed_at`과 몇 초 차이). 또는 백엔드가 인증서를 해당 엔드포인트 완료 시각과 비교. `SR_h3_fixed`(SLOW=TRUE, FIX_CERT=TRUE) 통과.

### F3. 워커가 manifest 접수 전에 로컬 상태를 확정해 "다시 나타남" 증거가 사라짐 (H2)
- 심각도: **medium** / 분류: **CONFIRMED**
- 트레이스(`SR_h2`, 15단계): `t1` 제거 → 실행 1 absent 접수(Skald quarantined) → 실행 2: F 엔드포인트 페이지 오류로 전체 incomplete, T 엔드포인트는 complete라 `t1` present 증거를 만들고 로컬 absence를 지움 → incomplete라 증거 전부 버림(:1161) → 실행 3 complete: 로컬에 absence가 없으니 present 증거도 없음 → 접수됐지만 Skald에는 `t1`이 계속 quarantined. 제출이 429/503/404로 실패해도 같은 결과입니다.
- 코드 근거: `finish_authoritative_reconciliation`이 snapshot·absence를 바꾸고 바로 저장(`sync_state.py:367-419`), 증거와 함께 다시 저장(`docs_collector.py:1048`), 제출은 그 뒤(:1164). 제출 실패 시 되돌리는 코드가 없음(:1165-1167). present 증거는 "직전 로컬 absence 키 − 이번 absence 키"(:983, :995)로만 만들어집니다.
- 영향: 현재 lifecycle disposition을 읽는 코드는 `specLifecycleService` 자신뿐이라 검색 노출에는 영향이 없지만, 메모 `metadata.spec_lifecycle`과 이벤트 기록이 영구히 틀립니다. 같은 구조 때문에 거절된 실행도 absence 횟수를 올려 F1·F2의 무한 반복을 만듭니다.
- 수정안: 엔드포인트별 결과를 스테이징해 두고 manifest 영수증(200)을 받은 뒤 한꺼번에 확정, 실패·incomplete면 버림. `SR_h2_fixed` 통과.

### F4. 재조정이 계속 거절돼도 승격(promoted)이 유지됨 (F1·F2의 결과)
- 심각도: **medium** / 분류: **CONFIRMED**
- 트레이스(`SR_h1_stale`): promoted 상태에서 `t1` 제거 → 404 두 번 연속 → `cnt = 2`, promoted 유지.
- 코드 근거: 거절은 트랜잭션 롤백이라 `applyAuthoritativeRun`의 리셋(`SpecPromotionState.ts:130-137`)이 일어나지 않음. 승격 상태는 "마지막으로 접수된" 실행만 반영합니다.
- 영향: MCP exact/native 기능이 "최신성이 증명된 투영"을 전제로 열려 있는데, 실제로는 재조정이 며칠째 실패해도 계속 열려 있게 됩니다.
- 수정안: F1·F2를 고치면 해소. 방어선으로 `promotion-check`/기능 노출이 `last_clean_completed_at`이 N시간(예: 48h) 안일 때만 promoted로 보게 하거나, 4xx 거절을 별도 트랜잭션으로 기록해 shadow로 내림. `SR_fixed`에서 `PromotionNotStale` 통과.

### F5. tombstone된 메모까지 매 실행 absent 증거를 다시 보냄, 증거는 단조 증가 (H4)
- 심각도: **low** / 분류: **CONFIRMED** (운영 데이터로 재전송 확인, 5000 도달은 아직 먼 일)
- 트레이스(`SR_h4`): `f1` 제거 → quarantined → tombstoned → 다음 실행이 또 absent(인증서 포함) 증거를 보냄. `SR_h4_cap`(CAP=1): 동시에 빠진 항목 수가 상한을 넘으면 zod 400으로 영구 거절.
- 코드 근거: absent 키는 snapshot에 계속 남고(`sync_state.py:407`) 다시 나타나기 전까지 `absence_evidence`에서 지워지지 않음(:367-373). 증거는 그 전부(:1004-1045). 백엔드는 매번 이벤트 행을 추가하고(`specLifecycleService.ts:363-388`) 메모 `metadata.spec_lifecycle.history`에 한 줄씩 덧붙임(:390-421). zod 상한 `max(5000)`(`specLifecycle.ts:54`), 페이지 나눔 없음.
- 운영 확인: lifecycle 이벤트 quarantined 826건(함수 코드 29개)·1517건(information 46개), tombstoned 32건(information 2개). 메모 history 최대 40줄. 현재 1회 증거 72건이라 5000까지는 여유가 크지만 history와 이벤트 행은 하루 72건씩 계속 늘어납니다.
- 수정안: 접수 영수증에서 tombstoned인 키는 워커 absence에서 빼고 "tombstoned" 표시만 남김(다시 나타나면 present 전송). 백엔드는 disposition이 바뀌지 않은 증거의 history 추가를 생략. 대량 삭제 대비로 증거를 나눠 보내는 경로도 필요합니다. `SR_h4_fixed` 통과.

### F6. 수동 /sync와 예약 재조정이 겹치면 한쪽이 내부 오류로 끝남 (H5)
- 심각도: **low** / 분류: **CONFIRMED**
- 트레이스(`CR_race`, 11단계): B가 run 1을 시작 → A가 같은 run 1에 합류(:909-911) → A가 끝까지 열거하고 `finish`로 run_id를 지움 → B의 다음 `update_reconciliation_manifest`가 `ValueError("No authoritative reconciliation is active")`. 세 번째 실행이 새 run을 시작한 뒤라면 `finish`에서 "Reconciliation run mismatch"(`sync_state.py:348-349`)가 납니다.
- 코드 근거: `/sync`(`routes.py:300-305`)와 예약 작업(`scheduler.py:99-108`)이 같은 싱글턴 `SyncStateManager`를 잠금 없이 사용. APScheduler 기본 max_instances=1은 예약 작업끼리만 막습니다. 워커는 1 replica(`k8s/worker-deployment.yaml:27`)라 파드 간 경합은 없습니다. `record_authoritative_presence`(:290-291)와 `update_reconciliation_manifest`(:301-302)가 run이 없으면 예외.
- 영향: 살아남은 실행의 snapshot은 완전하고(`SnapshotComplete` 통과) 실패한 쪽은 manifest를 내지 않아 데이터 손상은 없습니다. 운영자가 30분짜리 curl을 다시 보내거나 예약 시각(현재 매일 05:51 UTC)과 겹치면 수동 요청은 오류 응답, 예약 쪽은 `docs_authoritative` 실패 기록(`scheduler.py:115-119`)이 남습니다. "Reconciliation run mismatch" 경로는 코드 읽기로 확인했고 모델은 두 실행만 넣어 "No authoritative reconciliation is active" 경로를 재현했습니다.
- 수정안: 프로세스 전역 `asyncio.Lock`으로 `sync_authoritative_all`을 감싸고 두 번째 요청은 409 "재조정 진행 중"으로 응답. `CR_fixed` 통과.

### F7. 증분 docs_sync와 재조정이 같은 항목을 게시하면 가짜 drift로 승격이 풀림
- 심각도: **medium** / 분류: **NEEDS-RUNTIME** (두 작업이 겹치고 그 사이 SPMS에서 같은 항목이 수정돼야 함)
- 트레이스(`PR_stale`, 6단계): 재조정이 v1 상세를 가져옴 → SPMS에서 수정(v2) → 증분 동기화가 v2를 가져와 먼저 게시 → 재조정이 v1 게시 → 409 `STALE_REVISION` → manifest 오류(stage `detail_or_publish`) → `revision_drift = 1` → 실행이 clean이 아님 → promoted가 shadow로 리셋.
- 코드 근거: 게시는 source_key advisory lock으로 직렬화(`specRevisionService.ts:372-375`)되고 더 오래된 `source_updated_at`은 409(:411-422). 워커는 4xx를 오류로 기록(`clients/skald.py:64-75`, `docs_collector.py:969-972`)하고 그 개수를 `revision_drift`로 보고(:1151). drift가 있으면 리셋(`SpecPromotionState.ts:130-137`). 두 작업 사이 잠금 없음(`scheduler.py:297-319`).
- 수정안: 409 `STALE_REVISION` 중 "활성 리비전이 더 새것"인 경우를 drift가 아닌 superseded로 분류(또는 상세를 다시 가져와 재시도). `PR_fixed` 통과.

### F8. 같은 함수 코드를 가진 두 SPMS 스펙이 메모 하나를 공유해 서로 덮어씀
- 심각도: **medium** / 분류: **CONFIRMED** (운영 1건)
- 트레이스(`PR_shared`, 5단계): 스펙 a 게시 → 메모 = a → 스펙 b 게시 → 같은 메모를 b 내용으로 덮어씀 → a의 활성 리비전은 a인데 메모는 b.
- 코드 근거: 메모 키가 함수 코드(`docs_collector.py:745` `client_reference_id = code or ...`). 새 source는 메모를 `client_reference_id`로 찾아 남의 메모를 그대로 가져다 씀(`specRevisionService.ts:425-428`)하고 내용을 덮어씀(:449-456), `skald_spec_source.memo_id`도 같은 메모(:480, :612). 두 스펙의 advisory lock 키가 달라(:372) 서로 막지도 않습니다.
- 운영 확인: `skald_spec_source`에서 메모를 공유하는 쌍 1건, 함수 코드 `ONDEMAND-SVR-ORG-MEMBER-D`가 활성 리비전 2개에 있음. 메모 기반 검색·RAG에는 두 스펙 중 마지막에 게시된 것만 보입니다.
- 추가 위험(NEEDS-RUNTIME): 두 스펙이 같은 실행에서 함께 absent/present 증거를 내면 백엔드는 둘 다 메모 키(코드)로 이벤트를 기록하려다 유니크 키 `(project, scope, memo_reference_id, run_id)`(`Migration20260730132000.ts:9`)에 걸려 manifest 전체가 실패합니다(:256의 중복 검사는 스펙 ID 기준이라 못 막음).
- 수정안: 함수 메모 키를 불변 키(`spms:function:<id>`)로 하고 코드는 별칭으로만 사용. 최소한 다른 source가 이미 소유한 메모에는 붙지 않도록 `memo_id` 소유 검사를 추가. `PR_fixed` 통과.

### F9. 늦게 도착한 옛 비정상 manifest가 승격을 풀 수 있음
- 심각도: **low** / 분류: **MODEL-ONLY**
- 트레이스(`SP_order`): r1 clean(t=0) → r2 clean(t=2) promoted → t=0에 끝난 r3 비정상 manifest가 뒤늦게 도착 → shadow.
- 코드 근거: `applyAuthoritativeRun`은 비정상 실행에 대해 시각 비교 없이 리셋(`SpecPromotionState.ts:130-137`). 다만 워커가 1 replica이고 F6 때문에 두 재조정이 동시에 제출까지 가지 못하며, 워커는 같은 실행을 다시 제출하지 않으므로 현재 배포에서는 도달하지 않습니다. replica를 늘리거나 재전송을 넣으면 실제가 됩니다.
- 수정안(필요해지면): 리셋 전에 `run.started_at`이 마지막 clean 완료보다 이전이면 무시.

### F10. 매일 clean 실행이 품질 증거를 지워 related/conflict 기능이 다시 꺼짐
- 심각도: **low** / 분류: **CONFIRMED** (설계 의도일 가능성 높음)
- 트레이스(`SP_quality`): promoted + 품질 기록(r2) → 30분 넘게 지난 clean r3 → `quality_readiness = null`.
- 코드 근거: 횟수에 반영되는 clean 실행마다 `quality_readiness = null`(`SpecPromotionState.ts:151`), 기능 노출은 품질 증거의 run_id가 `last_clean_run_id`와 같을 때만(:118-121), 품질 기록은 현재 마지막 clean 실행에만 가능(`specLifecycleService.ts:482-488`). 매일 재조정이 clean이므로 품질 평가를 매일 다시 기록하지 않으면 related/conflict_candidates가 꺼집니다. 운영 상태도 `has_quality = false`.
- 제안: 의도라면 문서화. 아니라면 `manifest_hash`가 같은 clean 실행에서는 품질 증거를 유지하거나 평가 기록을 자동화.

## 6. 승격 상태기계 검증 결과 (요청 항목별)

| 항목 | 결과 |
| --- | --- |
| clean 횟수 2 상한 | 안전. `StateMatchesCount`, `PromotedSound` 통과(`SP_base`) |
| 30분 간격 | 안전. 30분 안의 clean은 횟수·상태를 바꾸지 않고 무시(음수 차이 포함). promoted 뒤 두 clean의 간격도 항상 30분 이상 |
| 리셋 | 비정상 실행 하나로 즉시 shadow와 품질 증거 소거. 거절된 manifest는 리셋하지 않음(F4) |
| 재전송(replay) | 안전. 같은 run_id는 내용이 같으면 멱등 응답, 다르면 409이고 어느 쪽도 상태를 바꾸지 않아 리셋 뒤 옛 clean을 재전송해 부활시킬 수 없음. 워커 run_id는 엔드포인트 run_id 해시라 실행마다 다름 |
| 순서 뒤바뀜 | 옛 clean은 무시되지만 옛 비정상은 강등시킴(F9, 현재 배포에서는 MODEL-ONLY) |
| stage-and-publish 동시성 | 같은 스펙은 source_key advisory lock(`specRevisionService.ts:372-375`, 트랜잭션 끝까지 유지)으로 직렬화되어 리비전 번호·활성 리비전이 꼬이지 않음. 결함은 F7·F8 |

## 7. 운영 근거 (읽기 전용, 2026-11-03)

- `skald_spec_promotion_state`: promoted, consecutive_clean_runs 2, last_clean_completed_at 2026-11-03 06:26:37 UTC, quality 없음.
- 최근 재조정 8회 모두 complete·drift 0, 소요 32~43분, 시작은 매일 05:51 UTC(IntervalTrigger 기준 시각). 전체 74회 중 complete 42회.
- 워커 상태 파일: functions 1086건(absence 26), techs 44(0), information 2354(46), troubleshoots 292(0). 모든 `reconciliation_run_id`는 비어 있음(진행 중 실행 없음).

## 8. 모델링하지 않은 것

- 승격 품질 지표 계산 자체(`recordQualityEvaluation`의 지표·해시 검증), 질의 manifest 등록.
- 스펙 관계(relation) 해석과 traversal 스냅샷, conflict review 이벤트.
- annotation 투영 재동기화(`specRevisionService.ts:653-662`): 커밋 뒤 best-effort로 실행되고 실패하면 로그만 남으며 재시도가 없어, NEEDS_REVIEW 주석이 검색 투영에 남을 수 있습니다. 실패 조건이 인프라 의존이라 코드 관찰로만 기록합니다(low, NEEDS-RUNTIME).
- 페이지 내부의 SPMS 정렬 이동(`sort=id`로 이미 수정됨), 서킷 브레이커와 재시도 정책, 워커 재시작 후 이어하기(재개 경로는 F6과 같은 공유 run_id 로직).
- grace(48h)·최소 간격(24h)·tombstone 24h의 시간 비교는 "서로 다른 날의 실행"으로 추상화했습니다.
