# Skald 논리 구조 TLA+ 검토 (종합)

검토 기준: origin/main `acb7241` (2026-11-02). 운영 코드는 바꾸지 않았고, 명세와 보고서만 추가했다.
도구: TLC 1.8.0 (`tla2tools.jar`), Java 21. 영역별 공통 지침은 [BRIEF.md](BRIEF.md).

실행 방법(영역 폴더에서):

```
java -XX:+UseParallelGC -cp tla2tools.jar tlc2.TLC -workers 4 -cleanup -deadlock \
  -metadir /tmp/tlc/<cfg> <Spec>.tla -config <Spec>_<cfg>.cfg
```

`-deadlock`은 유한 모델이 상한을 다 써서 멈추는 것을 결함으로 보지 않기 위해 쓴다. 활성 속성은 공정성 가정과 함께 따로 검사한다.

분류: CONFIRMED는 코드가 그 실행 순서를 허용함을 file:line으로 확인한 것, NEEDS-RUNTIME은 인프라 동작(브로커, 네트워크 등)에 달린 것, MODEL-ONLY는 모델 추상화의 산물이다.

## 영역별 결과 요약

| 영역 | 폴더 | 확인된 결함 | 높음 | 상세 |
| --- | --- | --- | --- | --- |
| 메모 처리 파이프라인 | [memo/](memo/README.md) | 8 | 3 | 아래 1절 |
| 공개메모 제출 승인 | [chat-submission/](chat-submission/README.md) A | 5 | 1 | 아래 2절 |
| 스펙 생명주기·승격·리비전 | [spec/](spec/README.md) | 10 | 2 | 아래 3절 |
| 채팅 SSE 스트리밍 | [chat-submission/](chat-submission/README.md) B | 10 | 1 | 아래 4절 |
| 위키 새로고침·컴파일러 | [wiki/](wiki/README.md) | 6 | 1 | 아래 5절 |
| 워커 런타임·디스코드 | [worker/](worker/README.md) | 11 | 0 | 아래 6절 |

합계 결함 50건(심각도 높음 8건). 운영 코드는 바꾸지 않았고, 결함마다 수정 설계를 넣은 모델이 TLC를 통과함을 확인했다.

## 먼저 고칠 것 (심각도 높음)

1. 메모 F1·F2·F4: 청크 중복(운영 7건), PATCH가 커밋 전 발행, CR 꺼진 운영에서 lazy 재처리 폭주(운영 5042개 중 3825개).
2. 제출 S2: 거절됐거나 미결인 제출이 공개 메모로 처리됨.
3. 스펙 F1·F2: SPMS에서 문서가 빠지거나 삭제되는 순간 재조정이 영구히 거절됨(잠복).
4. 채팅 C1: 프리뷰 대기 중 RAG 실패로 API 프로세스가 죽음.
5. 위키 W2: 컴파일 중 메모가 바뀌면 새 내용이 위키에 영영 반영되지 않음.

## 1. 메모 처리 파이프라인

| ID | 결함 | 심각도 | 분류 | 대표 cfg |
| --- | --- | --- | --- | --- |
| F1 | 같은 메모를 두 소비자가 동시에 처리해 청크가 두 벌 남음 | 높음 | CONFIRMED (운영 DB 7건) | dup_lazy, reuse_race |
| F2 | PATCH가 DB 커밋 전에 큐에 발행해 이전 내용 청크가 `processed`로 남음 | 높음 | CONFIRMED | update_race |
| F3 | 내용 변경 뒤 발행이 실패·유실되면 낡은 청크가 `processed`로 영구히 남음 | 중간 | 재수집 CONFIRMED, PATCH NEEDS-RUNTIME | reuse_lost, update_lost |
| F4 | CR 꺼진 운영 설정에서 lazy 재처리가 검색된 메모마다 청크를 지우고 다시 처리함 | 높음 | CONFIRMED (운영 5042개 중 3825개) | lazy_waste |
| F5 | 처리 완료·오류 기록이 metadata를 시작 시점 스냅샷으로 덮어씀 | 중간 | CONFIRMED | meta_lost |
| F6 | 항상 실패하는 메시지가 횟수 제한 없이 재큐됨(DLQ 없음) | 중간 | CONFIRMED | poison_live |
| F7 | sweeper가 큐가 한가할 때만 돌아, 바쁜 큐에서는 유실 메모가 복구되지 않음 | 낮음 | NEEDS-RUNTIME | busy_live |
| F8 | 처리 중 DELETE /memo가 지연 FK 검사로 500 | 낮음 | CONFIRMED | delete_fail |

수정 설계는 `fixed`, `fixed_nocr`, `fixed_delete`, `fixed_live`에서 모든 속성을 통과한다. 코드 근거와 수정안은 [memo/README.md](memo/README.md) 5-6절.

## 2. 공개메모 제출 승인

| ID | 결함 | 심각도 | 분류 |
| --- | --- | --- | --- |
| S1 | 승인과 거절이 겹치면 거절 200 뒤에 승인으로 뒤집힘 | 중간 | CONFIRMED |
| S2 | 거절됐거나 미결인 제출의 내용이 공개 메모로 처리됨 | 높음 | CONFIRMED |
| S3 | 이중 승인 시 메모가 두 개 생김 | 중간 | CONFIRMED |
| S4 | enqueue 실패 후 재시도가 성공하면 메모가 처리되지 않은 채 승인됨으로 남음 | 낮음 | CONFIRMED |
| S5 | 같은 reference_id를 가진 두 번째 제출 승인이 첫 번째 승인의 메모를 가져감 | 중간 | CONFIRMED |

공통 원인은 `backend/src/api/memoSubmission.ts`의 읽기-검사-무조건 쓰기 패턴이다(`:616-622` 검사, `:659-667` 쓰기, 사이에 메모 생성 await). 수정안은 `UPDATE ... WHERE status='pending'` 조건부 전이와 같은 트랜잭션 안의 outbox이며 `Submission_fixed`, `Submission_fixed_noref`에서 통과한다.

## 3. 스펙 생명주기·승격·리비전

| ID | 결함 | 심각도 | 분류 | 대표 cfg |
| --- | --- | --- | --- | --- |
| F1 | tech/troubleshoot가 SPMS에서 빠지면 워커가 `spms:tech:<id>`로 증거를 보내 저장 키 `spms:techs:<id>`와 어긋나 404, 매 실행 재전송으로 재조정이 영구히 거절됨 | 높음 | CONFIRMED (잠복) | SR_h1_live |
| F2 | 엔드포인트별 refetch `checked_at`을 전체 종료 시각과 15분 창으로 비교해 실제 삭제 시 인증서가 늘 만료됨(운영 실측 31분) | 높음 | CONFIRMED (잠복) | SR_h3 |
| F3 | manifest 접수 전에 로컬 snapshot·absence를 확정해 실패 시 "다시 나타남" 증거가 사라짐 | 중간 | CONFIRMED | SR_h2 |
| F4 | 재조정이 계속 거절돼도 promoted 상태가 유지됨 | 중간 | CONFIRMED | SR_h1_stale |
| F5 | tombstone된 키까지 absent 증거를 매번 재전송, 증거가 단조 증가(zod 상한 5000) | 낮음 | CONFIRMED | SR_h4, SR_h4_cap |
| F6 | 수동 `/sync`와 예약 재조정이 겹치면 한쪽이 run 불일치 예외로 끝남 | 낮음 | CONFIRMED | CR_race |
| F7 | 증분 동기화와 재조정이 같은 항목을 게시하면 `STALE_REVISION`이 drift로 집계돼 승격이 풀림 | 중간 | NEEDS-RUNTIME | PR_stale |
| F8 | 같은 함수 코드를 가진 두 SPMS 스펙이 메모 하나를 공유해 서로 덮어씀 | 중간 | CONFIRMED (운영 1건) | PR_shared |
| F9 | 늦게 도착한 옛 비정상 manifest가 승격을 풀 수 있음 | 낮음 | MODEL-ONLY (1 replica에서는 도달 안 함) | SP_order |
| F10 | 매일 clean 실행이 품질 증거를 지워 related/conflict 기능이 다시 꺼짐 | 낮음 | CONFIRMED (설계 의도 가능성) | SP_quality |

승격 상태기계의 핵심 규칙(clean 2회 상한, 30분 간격, 비정상 시 리셋)은 `SP_base`에서 안전하다. 같은 스펙 게시는 advisory lock으로 직렬화되어 안전하다. 수정안 전체를 넣은 `SR_fixed`, `CR_fixed`, `PR_fixed`가 통과한다. 근거는 [spec/README.md](spec/README.md) 5절.

## 4. 채팅 SSE 스트리밍

| ID | 결함 | 심각도 | 분류 | 대표 cfg |
| --- | --- | --- | --- | --- |
| C1 | 프리뷰 대기 중 ragGraph가 실패하면 처리되지 않은 reject로 API 프로세스가 죽음 | 높음 | CONFIRMED (빈도는 NEEDS-RUNTIME) | crash |
| C2 | 연결이 terminal 이벤트 없이 정상 EOF로 끝나면 UI가 영원히 스트리밍 상태 | 중간 | 클라이언트 누락 CONFIRMED | eof, eof_live |
| C3 | 서버 await가 멈추면 UI도 멈추고 사용자가 중단할 방법이 없음 | 중간 | NEEDS-RUNTIME | hang |
| C4 | 사용자 메시지 저장 실패 시 keepAlive interval 누수, error 이벤트 없음 | 중간 | CONFIRMED | leak |
| C5 | 공개 채팅: 생성 실패 뒤에도 빈·부분 답변을 저장하고 `done`까지 보냄 | 낮음 | CONFIRMED | public_terminal |
| C6 | 첫 terminal 이후 들어온 콜백이 새 스트림의 전역 상태를 끔 | 낮음 | CONFIRMED | public_late_done |
| C7 | 끝까지 나온 답변이 저장 실패로 `Error: ...`로 바뀜 | 낮음 | CONFIRMED | lost, public_lost |
| C8 | 공개 채팅 페이지를 스트리밍 중 다시 열면 새 대화가 숨은 이전 채팅을 이어 씀 | 중간 | CONFIRMED | public_clear, public_reuse |
| C9 | 클라이언트가 떠나도 서버는 RAG·LLM 생성과 저장을 끝까지 함 | 낮음 | CONFIRMED | tabclose |
| C10 | SSE 파싱 오류 후에도 계속 읽어 상태가 꼬임 | 낮음 | MODEL-ONLY | parse |

오래된 프리뷰가 최종 답변을 덮어쓰는 일은 없었다(`PreviewNeverOverwrites` 통과). 수정안을 넣은 `fixed_private`, `fixed_private_reset`, `fixed_public`, `fixed_public_reset`가 통과한다. 근거는 [chat-submission/README.md](chat-submission/README.md) B절.

## 5. 위키 새로고침·컴파일러

| ID | 결함 | 심각도 | 분류 | 대표 cfg |
| --- | --- | --- | --- | --- |
| W1 | 같은 요청을 두 작업자가 동시에 컴파일해 두 번 커밋(`Start`가 claim_token을 확인하지 않음) | 중간 | CONFIRMED | WR_claimrace, WR_stale |
| W2 | 컴파일 중 메모가 바뀌면 열린 요청만 고치고 새 요청을 안 만들어 새 내용이 반영 안 됨 | 높음 | CONFIRMED | WR_lostupdate |
| W3 | 메모를 이전 내용으로 되돌리면 위키가 중간 내용에 머무름 | 중간 | CONFIRMED | WR_revert |
| W4 | claim이 INSERT만 되고 지워지지 않음, 메모 삭제 뒤에도 남음 | 중간 | CONFIRMED | WR_claims, WR_delete |
| W5 | 크래시·발행 실패 뒤 요청이 열린 채 남고 주기적 재시도가 없음, 실행 행이 processing으로 고아 | 중간 | CONFIRMED | WR_crash, WR_publishfail, WR_orphanrun |
| W6 | 한 번 실패한 요청은 다시 시도되지 않음 | 낮음 | CONFIRMED | WR_failed |

수정 설계 12가지를 넣은 `WR_fixed`, `WR_fixed_faults`가 통과한다. RAG 캐시 무효화는 이번에 모델링하지 못했다. 근거는 [wiki/README.md](wiki/README.md).

## 6. 워커 런타임·디스코드 스트리밍

| ID | 결함 | 심각도 | 분류 | 대표 cfg |
| --- | --- | --- | --- | --- |
| CB-1 | HALF_OPEN 잠금을 잡지 않은 호출이 풀어 프로브가 여러 개 들어감 | 중간 | CONFIRMED | CircuitBreaker_probe |
| CB-2 | 프로브 진행 중 잠금이 풀림(CB-1과 같은 원인) | 중간 | CONFIRMED | CircuitBreaker_lock |
| CB-3 | 릴리스 수집기가 0초 sleep으로 대기 횟수를 즉시 소진해 버전을 실패 처리 | 중간 | CONFIRMED | CircuitBreaker_release |
| NC-1 | 수동 /sync와 cron이 겹치면 오래된 Notion 본문이 새 본문을 덮고 커서가 지나감 | 중간 | CONFIRMED | NotionCursor_concurrent |
| NC-2 | 실행 시작과 같은 분에 일어난 편집이 사라짐 | 중간 | CONFIRMED | NotionCursor_round |
| NC-3 | 삭제·이동된 Notion 페이지가 Skald에 영원히 남음 | 중간 | CONFIRMED | NotionCursor_orphan |
| NC-4 | max_pages로 잘린 실행도 커서를 전진시켜 잘린 페이지가 누락 | 낮음 | CONFIRMED (발생은 NEEDS-RUNTIME) | NotionCursor_trunc |
| SC-1 | 수동 /sync와 예약 잡이 겹치면 옛 내용이 새 내용을 덮음 | 낮음 | CONFIRMED | Scheduler_overlap |
| DS-1 | 디스코드 최종 편집이 실패하면 스트리밍 상태로 남거나 답변이 두 번 보임 | 낮음 | CONFIRMED | DiscordStream_stuck |
| DS-2 | 남은 스트리밍 청크 삭제 실패를 경고만 하고 둠 | 낮음 | CONFIRMED | DiscordStream_stale |
| DS-3 | 부분 답변을 보낸 뒤 경고 전송이 실패하면 답변이 오류 메시지로 지워짐 | 중간 | CONFIRMED | DiscordStream_partial |

디스코드 편집기는 모든 쓰기를 한 체인으로 직렬화하므로, REST 실패가 없으면 오래된 편집이 최종 답변을 덮는 순서는 없다(`DiscordStream_nofail` 통과). 서킷브레이커는 영원히 열린 채 멈추지는 않는다(`CircuitBreaker_live` 통과). 근거는 [worker/README.md](worker/README.md).

## 재검증 기록

영역 보고서를 받은 뒤 대표 cfg를 직접 다시 돌려 표와 대조했다(2026-11-03~04, linux5). 통과 실행은 상태 수까지 같았고 위반 실행은 같은 속성이 깨졌다.

| 영역 | 재실행한 cfg | 결과 |
| --- | --- | --- |
| memo | dup_lazy, update_race, poison_live, baseline(476), fixed_nocr(1,229,770), fixed_live(15,018) | 일치 |
| spec | SP_base(5,240), SR_h1_live, SR_h3, SR_fixed(2,152), CR_race, PR_shared, PR_fixed(531) | 일치 |
| chat-submission | ChatStream private_ok(704), crash, eof_live, public_reuse, fixed_public(20,826); Submission dup, rejmemo, sharedref, flip, leak, orphan, fixed(3,091), fixed_noref(3,937), orphan_sweeper(208) | 일치 |
| wiki | WR_* 13개 전부, fixed(59,431), fixed_faults(115,744) | 일치 |
| worker | CircuitBreaker probe, fixed(2,146); NotionCursor round; DiscordStream partial, fixed(2,333); Scheduler overlap, fixed(11,518) | 일치 |

`Submission_{flip,leak,orphan,fixed_noref}.cfg`는 작업 중 사라져 있어 보고서의 상수 요약대로 다시 만들었고, 결과와 상태 수가 보고서와 같았다. `NotionCursor_fixed`(316초)와 `WR_fixed_big`은 시간이 오래 걸려 재실행하지 않았다.

## 다루지 못한 것

- RAG 캐시(`backend/src/lib/ragCache.ts`) 무효화 순서.
- embedding-service, 프론트엔드의 나머지 스토어(인증·조직·구독), Jira/문서 수집기의 개별 커서.
- LLM·검색 품질 같은 논리 구조 밖의 성질.
