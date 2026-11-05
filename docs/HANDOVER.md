# 꾸리봇 추가 개발 인수인계 (2026-11-06)

## 확인한 기준과 기존 구현
GitHub main을 기준으로 분석했다. 기존 기능은 /모집, 게임/모드 입력, 시간·정원·역할 선택, 작성자 자동 참가, 참가/탈퇴, 확인 후 모집 취소, 개인 명단 조회이다. 서명 검증, D1 원자적 참가 처리, 재전송 receipt, Discord 게시 outbox/재시도도 유지했다.

추가한 기능은 순서 보존 대기열, 선택 전환/복원, 최근 본인 모집 5개 복사, 수락식 권한 위임, 확인 후 완료, 기존 글 수정이다. 정원 도달 시 참가 버튼을 계속 활성화하여 대기 신청을 받는다. 대기자가 있으면 빈자리에도 신규 신청자는 맨 뒤에 선다. 자동 승격·DM·초대·알림 타이머는 없다.

완료는 기존 status CHECK와 외래키를 보존하기 위해 completed 열로 구분한다. 완료 후 시간 종료 처리로 덮어쓰지 않는다. creator_id는 최초 작성자를 유지하며 owner_id만 위임된다. waiting.sequence는 승격 후에도 남아 원상 복구 순서를 제공하고, 본인 탈퇴 시 지워진다. 관리 작업은 receipt와 변경을 D1 batch 트랜잭션으로 처리한다. 권한·서버·채널·원본 메시지·최신 상태를 재검증한다.

## UI
/모집의 ‘내 최근 모집 복사’에서 최근 5개를 선택한다. 종료·완료·취소도 포함한다. 다른 서버/작성자의 글은 제외하며 시간은 비워 재입력하게 한다. 참가자·대기자·이력은 새 글로 복사하지 않는다.
모집글의 ‘모집 관리’는 모집자만 사용한다. 전환/복원/위임 대상은 선택 목록에서 고른 후 확인한다. 25명 단위 페이지를 제공한다. 위임 대상은 모집글의 ‘위임 수락/거절’을 눌러 응답한다. 요청은 15분 동안 유효하며 DM을 보내지 않는다. 수락 시 참가 여부와 요청 당시 모집자를 다시 검사한다.
수정은 기존 작성 UI를 재사용한다. 현재 인원 미만 정원은 거부한다. 기존 글에 최근 수정 전후 내용을 표시하며 역할을 재멘션하지 않는다. Discord 본문 제한을 위해 긴 변경 내역은 저장 전에 거부한다.

## 환경과 접근 확인의 한계
GitHub GGURIMON 계정 및 저장소 쓰기 권한 확인. 저장소에는 로컬/staging/production Worker와 D1 설정 구분이 이미 있다. 그러나 원격 D1 ID와 앱 ID/공개키는 빈값/자리표시자다. 실제 Cloudflare 계정의 DB, Worker, Secret 존재 여부와 현재 배포 설정은 확인하지 못했다. 비밀 값은 조회하거나 출력하지 않았다. 기존 테스트 DB ID를 새 DB로 덮어쓰지 말고 실제 기존 ID를 staging에 연결해야 한다.
Secret은 DISCORD_BOT_TOKEN, 설정은 DISCORD_APPLICATION_ID와 DISCORD_PUBLIC_KEY이다. 테스트/운영 Discord 애플리케이션과 토큰은 각각 분리한다. .dev.vars는 커밋하지 않는다.

## 테스트 환경 적용 (현재 작업에서는 실행하지 않음)
1. 실제 기존 테스트 Worker/DB 이름과 ID를 Cloudflare에서 확인한다. 저장소의 staging 자리표시자를 해당 ID로 채우고 운영 ID와 서로 다름을 확인한다.
2. DB 백업: `npx wrangler d1 export DB --remote --env staging --output work/staging-backup.sql` (민감 데이터 포함, 커밋 금지).
3. `npx wrangler d1 migrations list DB --remote --env staging`으로 현재 이력을 확인한다. 이미 0001/0002 스키마가 있지만 이력이 없는 DB라면 먼저 이력을 조정해야 하며 기존 CREATE TABLE을 재실행하지 않는다.
4. `npx wrangler d1 migrations apply DB --remote --env staging`. 새 변경은 0003_management.sql이며 테이블을 삭제하지 않는다. 기존 환경에서는 신규 열/테이블/트리거만 추가한다. 신규 운영 DB에는 모든 마이그레이션을 순서대로 적용한다.
5. 테스트 앱 ID/공개키 설정 후 `npx wrangler secret put DISCORD_BOT_TOKEN --env staging`.
6. `npm ci`, `npm run check`, `npm run build`, `npx wrangler deploy --env staging`.
7. 테스트 앱의 Interactions Endpoint를 해당 Worker의 /interactions로 연결하고 /health를 확인한다.

## Discord 전역 명령어
`npm run commands:register`는 .dev.vars의 앱/토큰으로 전역 /모집을 POST upsert한다. 다른 명령어를 전체 덮어쓰지 않는다. DISCORD_LEGACY_GUILD_IDS에 기존 등록 서버 ID들을 쉼표로 지정하면 전역 등록 성공 후 해당 서버의 동일 이름·타입 명령어만 삭제한다. 기존 DISCORD_GUILD_ID도 호환한다. 전체 서버를 자동 스캔하지 않으므로 모든 기존 등록 서버를 지정해야 한다. 실패 시 HTTP 상태/경로를 출력하고 비정상 종료한다. 토큰은 출력하지 않는다. 중간 실패 시 재실행 가능하다.
Developer Portal에서 Guild Install 활성화, bot 및 applications.commands scope, 앱 설치 대상과 서버별 명령어 접근 권한을 확인한다. 봇에는 채널 보기/메시지 보내기/기록 보기와 필요한 역할 멘션 권한이 있어야 한다. 두 번째 서버에도 설치하고 전역 /모집 표시를 확인한다.
공식 근거: https://docs.discord.com/developers/interactions/application-commands
D1 batch 트랜잭션: https://developers.cloudflare.com/d1/worker-api/d1-database/

## 검증 결과 및 남은 실연동 검증
로컬 Miniflare D1 + 가짜 Discord API로 총 55개 테스트 통과, TypeScript 검사 통과, Wrangler dry-run 번들 성공. 기존 정원 초과 버튼 비활성 테스트는 대기 신청 허용 동작에 맞춰 갱신했다. 추가 테스트는 대기 우회 방지/복원 순서/취소 재신청, 동시 전환, 서버 격리, 위임 거절·탈퇴·재위임·권한 승계, 완료 후 명단/복사, 수정 정원 검증과 멘션 차단을 포함한다.
실제 Discord 호출·전역 동기화·원격 마이그레이션·배포는 실행하지 않았다. 실제 서버에서 Modal/Select 렌더링, Ephemeral 응답, 두 서버 데이터 격리, 동시 클릭, 25명 이상 관리 페이지, 종료 후 명단, 완료/취소 상태 표시, 역할 권한, 위임 후 기존 모집자 탈퇴, 수정 시 단일 원본 글 갱신을 확인해야 한다. API 오류는 interaction_error / message_sync_retry / message_sync_blocked 로그와 message_jobs.last_error_code를 확인한다. UI가 아닌 DB에 저장된 결과가 기준이며 게시 갱신은 재시도될 수 있다.

## 운영 전환 (별도 확인 필요)
새 운영 D1·Worker·Discord 앱 생성은 사용자의 명시적 확인 이후에 수행한다. 신규 DB에는 스키마만 적용하고 테스트 데이터는 가져오지 않는다. production 자리표시자를 새 DB ID로 바꾸고 별도 운영 앱 설정과 Secret을 넣는다. 테스트 검증한 동일 커밋을 운영으로 배포하며 운영 앱 기준으로 전역 명령어를 별도 동기화한다. 기존 운영/테스트 자원 삭제·초기화는 필요하지 않다. DB 복원은 신규 쓰기 손실을 유발할 수 있으므로 문제 발생 시 먼저 쓰기를 중단하고 백업/Time Travel 시점을 검토한다. 코드만 과거로 되돌리면 새 대기/완료 기능을 무시할 수 있어 구버전 롤백도 별도 검토가 필요하다.
기존 1분 Cron과 게시 동기화 구조를 유지하고 별도 폴링/유료 서비스는 추가하지 않았다. 무료 사용량은 실제 트래픽과 Cloudflare 사용량 화면에서 확인해야 하며 무료 운영을 보장하지 않는다.
