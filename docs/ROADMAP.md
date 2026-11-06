# 개발 로드맵

확인일: 2026-11-06 (KST)

## 기준과 상태 해석

- 기본 브랜치: [main `b202c5f`](https://github.com/GGURIMON/Discord_Bot_Project/commit/b202c5f5936dc01a7648401754ceac70a9e12d9a).
- 진행 중 구현: [Draft PR #1](https://github.com/GGURIMON/Discord_Bot_Project/pull/1), `feat/recruitment-management` / [`1923539`](https://github.com/GGURIMON/Discord_Bot_Project/commit/19235398cbaf59e461a16d35000f547eb3fc46d5). 아직 main에 병합되지 않았다.
- **구현**은 코드 경로와 관련 테스트의 존재를 확인했다는 뜻이다. 실서버 검증·운영 배포 완료와 구분한다. 이 문서 작성 과정에서 테스트 실행, 명령어 등록, DB 변경, 배포는 수행하지 않았다.
- 기존 이슈 목록에는 PR #1만 있었으며 기능별 TODO는 아래 이슈로 분리했다. 구현 코드가 이미 있는 항목은 재개발 대신 검토·회귀 검증·반영 작업을 추적한다.

## 현재 유지할 기능

main에는 /모집 작성, 게임/모드·시간·정원·역할 입력, 모집자 자동 참가, 참가/탈퇴, 확인 후 모집 취소, 비공개 참가자 목록과 페이지 이동, 시간 종료 처리가 있다. 서명 검증, D1 batch와 interaction receipt, 게시/수정 작업 재시도 구조를 보존한다.

근거: [interactions.ts](https://github.com/GGURIMON/Discord_Bot_Project/blob/b202c5f5936dc01a7648401754ceac70a9e12d9a/src/interactions.ts), [repository.ts](https://github.com/GGURIMON/Discord_Bot_Project/blob/b202c5f5936dc01a7648401754ceac70a9e12d9a/src/database/repository.ts), [domain.ts](https://github.com/GGURIMON/Discord_Bot_Project/blob/b202c5f5936dc01a7648401754ceac70a9e12d9a/src/domain.ts), [통합 테스트](https://github.com/GGURIMON/Discord_Bot_Project/blob/b202c5f5936dc01a7648401754ceac70a9e12d9a/tests/integration.test.ts).

## 기능별 상태와 TODO

| 기능 | main 상태 | PR #1 상태 | 우선순위 | TODO |
| --- | --- | --- | --- | --- |
| Global Application Commands 전환 검증 | Guild 명령어만 구현 | 전역 등록 구현·미병합 | P1 | [#2](https://github.com/GGURIMON/Discord_Bot_Project/issues/2) |
| 다중 서버 Guild ID 격리 회귀 검증 | 기본 모집 경로 격리 구현 | 관리·복사 경로까지 확장·미병합 | P1 | [#3](https://github.com/GGURIMON/Discord_Bot_Project/issues/3) |
| 모집 완료 기능 검토 및 반영 | 미구현 (취소/시간 종료와 별개) | 구현·미병합 | P1 | [#4](https://github.com/GGURIMON/Discord_Bot_Project/issues/4) |
| 모집 내용 수정 기능 검토 및 반영 | 미구현 (초안 수정만 가능) | 구현·미병합 | P1 | [#5](https://github.com/GGURIMON/Discord_Bot_Project/issues/5) |
| 대기자 수동 관리와 최초 순번 복원 검토 | 미구현 (만원이면 거부) | 구현·미병합 | P1 | [#6](https://github.com/GGURIMON/Discord_Bot_Project/issues/6) |
| 본인 최근 모집 5개 복사 검토 및 반영 | 미구현 | 구현·미병합 | P1 | [#7](https://github.com/GGURIMON/Discord_Bot_Project/issues/7) |
| 수락 기반 모집자 권한 위임 검토 및 반영 | 미구현 | 구현·미병합 | P1 | [#8](https://github.com/GGURIMON/Discord_Bot_Project/issues/8) |
| 기존 테스트 D1 보존 및 운영 DB·Worker 분리 확인 | 설정 틀 존재·실제 분리 미확인 | 동일; 테스트 적용 보고만 존재 | P0 | [#9](https://github.com/GGURIMON/Discord_Bot_Project/issues/9) |
| 일일 워들 MVP: 공통 문제·사전·개인 기록 | 미구현 | 미구현 | P2 | [#10](https://github.com/GGURIMON/Discord_Bot_Project/issues/10) |
| 워들 통계·랭크 후속 설계 | 미구현·후속 | 미구현·후속 | 후속 | [#11](https://github.com/GGURIMON/Discord_Bot_Project/issues/11) |
| 게임 시작 10분 전 알림 범위 정리 | 시작 알림 미구현 | 구현 코드 존재·계획상 보류 | 보류 | [#12](https://github.com/GGURIMON/Discord_Bot_Project/issues/12) |

## 모집 기능의 코드 근거

- 전역 명령어: main의 [등록 스크립트](https://github.com/GGURIMON/Discord_Bot_Project/blob/b202c5f5936dc01a7648401754ceac70a9e12d9a/scripts/register-commands.mjs)는 Guild 경로를 사용한다. PR #1의 [등록 스크립트](https://github.com/GGURIMON/Discord_Bot_Project/blob/19235398cbaf59e461a16d35000f547eb3fc46d5/scripts/register-commands.mjs)는 전역 upsert 후 명시한 legacy guild에서 같은 이름·타입만 제거한다. 실제 전역 등록과 두 번째 서버 노출은 별도 확인이다.
- 서버 격리: main의 draft·참가·목록에 guild/channel/message 검증이 있고, PR #1 [scoped/manage](https://github.com/GGURIMON/Discord_Bot_Project/blob/19235398cbaf59e461a16d35000f547eb3fc46d5/src/database/management.ts)가 관리 작업에도 적용한다. [통합 테스트](https://github.com/GGURIMON/Discord_Bot_Project/blob/19235398cbaf59e461a16d35000f547eb3fc46d5/tests/integration.test.ts)에 다른 서버/채널/메시지 거부 사례가 있다.
- 완료·수동 대기 전환·원래 순번 복원·수락식 위임: [management.ts](https://github.com/GGURIMON/Discord_Bot_Project/blob/19235398cbaf59e461a16d35000f547eb3fc46d5/src/database/management.ts), [0003 마이그레이션](https://github.com/GGURIMON/Discord_Bot_Project/blob/19235398cbaf59e461a16d35000f547eb3fc46d5/migrations/0003_management.sql), [관리 테스트](https://github.com/GGURIMON/Discord_Bot_Project/blob/19235398cbaf59e461a16d35000f547eb3fc46d5/tests/management.test.ts). waiting.sequence는 승격 후 보존되며, 본인 탈퇴 후 재신청은 뒤로 간다. 위임은 현재 참가자 대상·15분 만료·수락 시 owner_id 변경이며 creator_id는 유지한다.
- 수정: [Repository.editDraft](https://github.com/GGURIMON/Discord_Bot_Project/blob/19235398cbaf59e461a16d35000f547eb3fc46d5/src/database/repository.ts)와 [interaction 처리](https://github.com/GGURIMON/Discord_Bot_Project/blob/19235398cbaf59e461a16d35000f547eb3fc46d5/src/interactions.ts)가 원본 메시지·참가자를 유지한다. 참가 인원보다 작은 정원 변경과 오래된 버전은 거부한다.
- 복사: [interactions.ts](https://github.com/GGURIMON/Discord_Bot_Project/blob/19235398cbaf59e461a16d35000f547eb3fc46d5/src/interactions.ts)가 guild_id + creator_id로 최근 5개를 조회한다. 새 모집은 모집자만 참가하며 원본 명단은 보존한다. 취소 시 기존 초안 복귀 테스트도 있다.

## 진행 순서와 완료 기준

1. **P0 — 환경 확인:** [#9](https://github.com/GGURIMON/Discord_Bot_Project/issues/9). 기존 테스트 D1·Worker 식별자와 마이그레이션 이력을 확인·백업한다. 새 운영 DB/Worker는 별도로 구성하고 테스트 데이터를 운영으로 복사하지 않는다.
2. **P1 — 기존 모집 확장 검토:** [#2–#8](https://github.com/GGURIMON/Discord_Bot_Project/issues/2). PR #1의 기존 구현을 검토하고 관련 테스트 및 두 서버 Discord 실사용 검증을 기록한다. 보류한 알림의 반영 범위를 먼저 결정한다. 기능별 완료 조건 충족·main 반영·실서버 검증을 구분해 기록한다.
3. **P2 — 일일 워들 MVP:** [#10](https://github.com/GGURIMON/Discord_Bot_Project/issues/10). 아래 확정 요구사항으로 별도 구현 PR을 진행한다. 모집 기능 회귀 검증을 포함한다.
4. **후속 — 워들 통계·랭크:** [#11](https://github.com/GGURIMON/Discord_Bot_Project/issues/11). MVP 기록 구조가 안정된 뒤 집계·랭크 규칙을 결정한다.

## 일일 워들 요구사항

- /워들, 영어 5글자, 최대 6회. 중복 글자까지 Wordle 방식으로 판정한다.
- 매일 **KST 자정**에 새 문제로 전환하며 모든 서버가 같은 날짜의 같은 문제를 사용한다. 당일 사전 배포로 정답이 바뀌지 않게 날짜별 정답/사전 버전을 고정한다.
- 폭넓은 **입력 허용 사전**과 흔한 단어를 선별한 **정답 사전**을 분리한다. 기존 공개 자료를 조사해 출처·재사용 조건을 확인하고 5글자만 정규화·중복 제거한다. 정답은 입력 사전의 부분집합이어야 한다. 구체 라이브러리와 단어 수는 아직 미선정이다.
- 날짜 + Discord 사용자 ID를 기준으로 개인 기록을 저장한다. 같은 사용자가 다른 서버에서 열어도 같은 진행 상태를 이어간다. 승리 또는 6회 소진 후 당일 재시작/초기화는 허용하지 않는다.
- 비공개 진행, 종료 전 정답 비노출, 정답 없는 색상 격자 결과 공유. 잘못된 입력은 횟수를 차감하지 않는다.
- 동시 입력·재전송·KST 날짜 경계를 안전하게 처리한다. 테스트/운영 기록과 모집 데이터를 분리한다. 사전은 정적 데이터 포함을 우선 검토하며 별도 사전 DB나 불필요한 Cron/외부 API는 필수 조건이 아니다.

## 환경 및 보류 항목

[wrangler.jsonc](https://github.com/GGURIMON/Discord_Bot_Project/blob/b202c5f5936dc01a7648401754ceac70a9e12d9a/wrangler.jsonc)에 staging/production Worker·D1 설정 틀은 있지만 실제 DB ID는 자리표시자다. [운영 배포 workflow](https://github.com/GGURIMON/Discord_Bot_Project/blob/b202c5f5936dc01a7648401754ceac70a9e12d9a/.github/workflows/deploy.yml)는 main의 수동 실행 경로다. 설정 파일만으로 실제 자원 분리를 완료 처리할 수 없다. PR #1 [HANDOVER](https://github.com/GGURIMON/Discord_Bot_Project/blob/19235398cbaf59e461a16d35000f547eb3fc46d5/docs/HANDOVER.md)에는 테스트 적용 및 79개 테스트 통과 보고가 있지만 이번 작업에서 재실행하거나 원격 상태를 검증한 결과는 아니다. 조회된 GitHub Actions 실행 목록은 비어 있었다.

**10분 전 알림은 보류**한다 ([#12](https://github.com/GGURIMON/Discord_Bot_Project/issues/12)). 다만 PR #1에는 [StartReminders](https://github.com/GGURIMON/Discord_Bot_Project/blob/19235398cbaf59e461a16d35000f547eb3fc46d5/src/services/reminders.ts), 자동 스레드/멤버 관리, 0004~0006 마이그레이션과 관련 테스트가 이미 포함되어 있다. 보류와 코드 존재의 차이를 숨기지 않는다. PR #1 병합 전에 알림·스레드 변경의 분리 또는 비활성화 여부를 결정해야 한다. 이 문서는 그 코드를 삭제하거나 활성화하지 않는다.

## 관리 규칙

개별 요구사항·검증 결과는 연결된 Issue에서 관리하고, 단계나 구현 상태가 바뀌면 이 표와 기준 커밋을 갱신한다. 병합 시 이 계획 PR이 기능 Issue를 자동 종료하지 않도록 한다. 기존 테스트 DB 삭제·초기화, 운영 배포, 기존 PR #1 수정·병합은 이번 문서 정리의 범위에 포함하지 않는다.
