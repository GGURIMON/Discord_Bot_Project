# Discord 게임 모집 봇 — Phase 1 설계안

작성일: 2026-11-05. 이 문서는 초기 설계 기록이다. 이후 사용자의 코드 작성 승인에 따라 구현을 진행했다. 현재 구현과 검증 결과는 README.md와 IMPLEMENTATION.md를 기준으로 확인한다. 외부 계정 변경과 실제 배포는 아직 진행하지 않았다.

## 1. 결정 요약

TypeScript + Cloudflare Workers HTTP Interactions + D1을 사용한다. Gateway, 역할 생성·부여, 외부 상시 서버는 사용하지 않는다. 최종 모집글은 `content`와 기존 Action Row/Button을 사용하며 `IS_COMPONENTS_V2` 플래그를 켜지 않는다. 입력 안내와 오류는 작성자에게만 보이는 ephemeral 메시지로 제공한다.

## 2. 작성 흐름

1. 서버 채널에서 `/모집` 실행 → 개인 입력 패널 표시. DM에서는 사용할 수 없다.
2. String Select로 게임 복수 선택. 설정 파일의 게임 ID와 표시 이름을 분리한다. 메뉴 선택지는 최대 25개이므로 목록이 커지면 페이지 이동과 페이지별 선택 상태를 저장한다.
3. `상세 입력` 버튼 → Modal. 입력란은 시작 `HH:mm`, 종료 `HH:mm`, 최대 인원, 게임별 모드, 직접 입력 게임으로 구성한다. 모드는 `에이펙스 레전드=일반 or 랭크`처럼 줄마다 입력하고 선택 게임과 대조한다. 직접 입력 게임은 한 줄에 하나씩 `게임명(설명)` 형식을 지원한다. 최소 한 게임 필요.
4. 개인 패널의 Role Select에서 기존 역할을 0~25개 선택한다. 역할 이름을 저장된 상수로 대체하지 않고 Discord의 resolved 데이터 및 실제 역할 ID를 검증한다. 역할 변경 기능은 없다.
5. 개인 미리보기에서 `게시` → 검증 후 공개 메시지 생성. 미리보기는 알림을 발생시키지 않는다. 게시 후 작성 상태를 소비 처리하여 중복 게시를 방지한다.

게임과 역할 선택은 개인 메시지 메뉴, 시간·설명은 Modal로 분리한다. 현재 공식 문서는 Modal 내 Select도 지원하지만, 입력량과 재편집 편의상 단계형 패널을 선택한다. Modal을 띄우는 버튼은 즉시 type 9로 응답하며 먼저 defer하지 않는다. Modal 제출 후 다음 Modal을 직접 띄우지 않고 패널로 돌아간다.

작성 상태는 `(draft_id, guild_id, channel_id, owner_id)`로 묶고 15분 만료한다. 모든 조작에서 작성자·서버·채널·만료·버전을 검사한다. Discord interaction token은 작성 상태 자체와 별개이며 장기 보관하지 않는다. 만료된 패널은 `/모집` 재실행을 안내한다.

## 3. 최종 메시지

```text
에이펙스 레전드(일반 or 랭크), 데드락(빠른 or 일반) / 13:00 ~ 14:30 / [1/4] / <@&역할ID1>, <@&역할ID2>
[참가하기] [참가 취소] [모집 취소]
```

실제 Discord에서는 역할 이름으로 렌더링된다. 역할 미선택 시 마지막 구분자와 멘션 영역을 생략한다. 제목·Embed·추가 안내는 공개 본문에 넣지 않는다. 취소 시에만 `[취소됨] ` 접두사를 붙인다. 모집 취소는 작성자만 허용하고 개인 확인 버튼을 거친다. 작성자의 참가 취소 클릭은 참가자를 삭제하지 않고 모집 취소 경로를 안내한다.

정원이 차면 참가 버튼만 비활성화한다. 빈자리가 생기면 다시 활성화한다. 취소·종료 시 모든 변경 버튼을 비활성화한다. 사용자 직접 입력에 멘션/마크다운을 의도하지 않게 삽입할 수 없도록 정규화하고 최종 content 2,000자 이내를 검증한다.

최초 게시의 `allowed_mentions`는 `{parse: [], roles: 선택한ID목록, users: [], replied_user: false}`. 수정과 미리보기는 `{parse: [], users: [], roles: [], replied_user: false}`를 명시한다. `@everyone` 역할은 허용하지 않는다. 실제 알림은 역할의 mentionable 속성 또는 봇의 권한이 필요하며 사용자 알림 설정에 따라 달라진다. 기본적으로 멘션 가능한 역할만 허용하고 광범위한 Mention Everyone 권한을 요구하지 않는다. 역할이 삭제되거나 권한이 바뀌면 게시 전에 사용자에게 재선택을 안내한다.

## 4. 시간 규칙 — 제안 기본값

기본 시간대는 Asia/Seoul. 시작 날짜는 작성 시점의 한국 날짜를 사용한다. 미래 시각이 필요한데 오늘 시작 시간이 지났으면 조용히 내일로 바꾸지 않고 검증 오류로 안내한다. 첫 버전은 당일 시작 모집에 집중한다. 종료 시각이 시작보다 이르면 다음 날 종료, 같으면 잘못된 입력으로 처리한다. UTC epoch와 시간대 식별자를 저장하고 표시할 때 한국 시간으로 변환한다. 23:00~01:00은 내부적으로 다음 날 종료이나 공개 본문 형식은 그대로 유지하고 개인 미리보기에 날짜를 표시한다.

종료 후에는 신규 참가와 취소를 막고 ended로 전환하는 것을 제안한다. 요청 시점에 종료 시각을 반드시 검사하며 Cron이 종료 표시를 갱신한다. 최대 인원은 1 이상의 정수이고 첫 버전 상한은 999명으로 제안한다. 이 상한은 Discord의 참가자 제한이 아닌 입력 오류 방지용 제품 정책이다.

## 5. 데이터 모델

| 테이블 | 핵심 필드와 제약 |
| --- | --- |
| recruitments | id, guild_id, channel_id, message_id, owner_id, games_json, starts_at, ends_at, timezone, max_members, role_ids_json, status, version, synced_version, created_at, updated_at |
| participants | id, recruitment_id, user_id, joined_at; UNIQUE(recruitment_id, user_id), FK recruitment_id |
| drafts | id, guild_id, channel_id, owner_id, payload_json, version, expires_at, consumed_at |
| interaction_receipts | interaction_id PK, operation, resource_id, result_json, created_at, expires_at |
| message_jobs | recruitment_id UNIQUE, target_version, attempts, next_attempt_at, lease_owner, lease_expires_at, last_error_code |

상태는 publishing/open/cancelled/ended/publish_failed. full은 별도 저장하지 않고 현재 참가자 수로 계산한다. 정원 1이면 작성자만 등록하고 즉시 참가 버튼을 비활성화한다. 서버·상태·종료시각, 만료, 재시도 시각에 인덱스를 둔다. 참가자 수는 모집 ID 인덱스를 이용한 COUNT로 계산해 별도 카운터 불일치를 피한다.

모든 사용자 조작은 interaction의 guild/channel/message ID와 DB 값을 대조한다. custom_id는 식별용이며 권한 근거로 신뢰하지 않는다. 모집자 고정 규칙은 서비스 계층과 DB 삭제 방어로 강제한다. DB 마이그레이션은 Wrangler D1 migrations로 관리한다.

## 6. 동시성 및 멱등성

핵심 참가 처리는 애플리케이션의 조회 후 INSERT가 아니라 아래 형태의 단일 원자적 SQL로 수행한다.

```sql
INSERT INTO participants (id, recruitment_id, user_id, joined_at)
SELECT ?1, r.id, ?3, ?4
FROM recruitments r
WHERE r.id = ?2 AND r.guild_id = ?5 AND r.status = 'open'
  AND r.ends_at > ?4
  AND NOT EXISTS (
    SELECT 1 FROM participants WHERE recruitment_id = r.id AND user_id = ?3
  )
  AND (SELECT COUNT(*) FROM participants WHERE recruitment_id = r.id) < r.max_members;
```

participants의 UNIQUE로 중복을 추가 차단한다. 모든 참가 INSERT 경로에 적용되는 BEFORE INSERT 트리거로 상태·종료·정원 검사도 강제한다. 작성자 자동 등록은 publishing 상태의 소유자에 한해서 허용한다. D1 `batch()`는 순차 실행되는 트랜잭션이며 하나가 실패하면 전체 롤백된다. 명시적인 BEGIN/COMMIT 및 JS 콜백 트랜잭션을 가정하지 않는다.

참가/취소, 결과 기록, version 증가, message_jobs 등록은 하나의 batch 또는 트리거로 묶는다. interaction_id는 유일하며 동일 interaction 재전송은 저장된 결과를 재사용한다. 별도 사전 조회만으로 중복을 막지 않는다. 중복 참가처럼 영향 행이 0인 경우도 batch 안의 조회 결과를 기준으로 이유를 판정한다. 모집 생성과 작성자 자동 등록도 한 batch로 처리한다.

## 7. HTTP 처리와 Discord 동기화

요청 raw body와 timestamp를 Ed25519 검증한 뒤 JSON을 처리한다. 누락·잘못된 서명은 401, PING은 PONG이다. mutation은 3초 안에 개인 deferred 응답(type 5, ephemeral)을 반환하고 후속 작업을 수행한다. 버튼 mutation의 초기 응답에 공개 메시지 내용을 직접 싣지 않아 오래된 인원수의 역순 반영을 줄인다. `waitUntil`은 빠른 후속 처리용이며 영속 큐로 간주하지 않는다.

DB가 진실의 원천이다. DB 변경과 message_jobs를 함께 기록하고, 후속 처리 또는 Cron이 D1의 최신 값을 읽어 Bot Token으로 메시지를 PATCH한다. 생성 당시 interaction token의 15분 만료에 의존하지 않는다. 모집별 DB lease로 갱신 작업을 직렬화하고, 갱신 중 version이 바뀌면 다시 처리한다. synced_version은 실제 전송한 버전까지만 기록한다. 느린 네트워크·lease 만료로 일시적으로 오래된 내용이 표시될 수 있으므로 완료 전 버전 재검사와 Cron 복구를 둔다. DB와 Discord의 분산 원자적 트랜잭션은 불가능하며 최종 일관성을 제공한다.

429는 retry_after, 일시적인 5xx/네트워크 실패는 제한된 지수 백오프를 적용한다. 403/404는 권한 또는 메시지 삭제로 분류하고 무한 재시도하지 않는다. 비밀값과 interaction token은 로그에 기록하지 않는다.

최초 게시에는 Discord의 nonce/enforce_nonce를 활용하고 생성 작업 ID를 안정적으로 유지한다. 다만 nonce 중복 방지 보장은 최근 메시지에 한정되므로 장기 장애 후 무조건 재게시하지 않는다. 전송 성공 후 DB 기록 실패처럼 결과가 불명확하면 제한적인 최근 메시지 대조와 운영자 확인으로 복구한다. 최초 역할 알림을 임의로 반복하지 않는다.

## 8. 무료 운영과 배포

공식 문서 기준 Workers Free는 일 100,000 요청, 요청당 CPU 10ms이다. D1 Free는 일 500만 rows read, 10만 rows written, 계정 합계 5GB다. 소규모 서버 운영에 적합할 것으로 판단하지만 실사용 규모와 서명 검증 CPU는 배포 후 계측해야 한다. 인덱스·batch·대상 제한 Cron으로 비용을 줄이고 무료 한도 도달 시 서비스가 제한될 수 있음을 운영 문서에 기록한다. 유료 플랜 자동 전환을 전제로 하지 않는다.

CI/CD는 GitHub Actions를 선택한다. PR에서 타입 검사·단위·Workers/D1 통합 테스트를 실행하고 배포 job은 GitHub production Environment 승인을 거친다. 마이그레이션은 하위 호환 변경을 우선하며 DB 변경이 배포와 자동 롤백되지 않음을 명시한다. 처음에는 수동 승인 배포로 연결하고 승인 정책 변경은 별도 확인한다.

local/staging/production DB와 Worker를 분리한다. Bot Token은 Cloudflare Secrets, 배포 API Token은 최소 권한 GitHub Secrets에 저장한다. public key/application ID는 비밀이 아니지만 환경별 분리한다. .dev.vars, .env, .wrangler 및 로그를 Git에서 제외하고 값 없는 예시만 제공한다.

외부 저장소 생성·계정 연결·Discord 명령어 등록·Cloudflare 리소스 생성·실제 배포는 사용자 확인 후 진행한다. 현재 단계에서는 수행하지 않는다.

## 9. 구현과 검증 계획

Phase 2: TypeScript/Wrangler 설정, 서명 검증, PING, 타입 검사 및 HTTP 테스트.

Phase 3: 입력 패널, Modal, Role Select, 시간 검증, D1 마이그레이션, 게시 및 작성자 등록.

Phase 4~5: 원자적 참가/취소, 작성자 모집 취소, 종료 처리, 멱등성, 메시지 작업 복구, rate limit 처리.

테스트는 요구사항의 18개 시나리오를 단위/로컬 Workers+D1 통합 테스트에 매핑한다. 동시성 검증은 mock DB가 아닌 실제 로컬 D1에 병렬 요청하여 정원 초과·중복·취소 후 재참가를 확인한다. API 장애 및 역순 갱신, 중복 interaction, draft 만료·타인 접근, 자정 경계, 최초 게시 결과 불명확도 포함한다. 실제 역할 알림과 Discord 클라이언트 UI는 테스트 서버에서 별도 검증하며 모의 테스트 통과만으로 실서버 검증을 주장하지 않는다.

## 10. 검토가 필요한 제안 기본값

- 당일 시작, 자정 이후 종료 지원. 같은 시작/종료는 금지.
- 종료 시각 이후 모집 마감.
- 정원 1~999명, 역할 최대 25개, 입력 상태 15분 만료.
- 멘션 가능한 역할만 허용하고 광범위한 멘션 권한은 기본 요청하지 않음.
- 모집 취소 버튼 추가, 취소된 본문에 `[취소됨]` 표시.

이 설계를 확인받은 후 Phase 2를 시작한다.

## 공식 근거

- Discord 컴포넌트, Select 제한, Role Select 및 기존 메시지 형식: https://docs.discord.com/developers/components/reference
- Modal: https://docs.discord.com/developers/components/using-modal-components
- 서명 검증, 3초 응답, 15분 token: https://docs.discord.com/developers/interactions/receiving-and-responding
- content, allowed_mentions, nonce, 메시지 생성/수정: https://docs.discord.com/developers/resources/message
- D1 batch 트랜잭션: https://developers.cloudflare.com/d1/worker-api/d1-database/
- Workers 한도: https://developers.cloudflare.com/workers/platform/limits/
- D1 무료 한도: https://developers.cloudflare.com/d1/platform/pricing/

현재 문서 확인과 설계만 완료했다. 실행 코드, 테스트 실행, 실제 Discord/Cloudflare 환경 검증은 아직 수행하지 않았다.
