# 꾸리봇 추가 개발 인수인계 (2026-11-06)

## 확인한 기준과 기존 구현
GitHub main을 기준으로 분석했다. 기존 기능은 /모집, 게임/모드 입력, 시간·정원·역할 선택, 작성자 자동 참가, 참가/탈퇴, 확인 후 모집 취소, 개인 명단 조회이다. 서명 검증, D1 원자적 참가 처리, 재전송 receipt, Discord 게시 outbox/재시도도 유지했다.

추가한 기능은 순서 보존 대기열, 선택 전환/복원, 최근 본인 모집 5개 복사, 수락식 권한 위임, 확인 후 완료, 기존 글 수정이다. 정원 도달 시 참가 버튼을 계속 활성화하여 대기 신청을 받는다. 대기자가 있으면 빈자리에도 신규 신청자는 맨 뒤에 선다. 대기자는 모집자가 직접 전환한다.

완료는 기존 status CHECK와 외래키를 보존하기 위해 completed 열로 구분한다. 완료 후 시간 종료 처리로 덮어쓰지 않는다. creator_id는 최초 작성자를 유지하며 owner_id만 위임된다. waiting.sequence는 승격 후에도 남아 원상 복구 순서를 제공하고, 본인 탈퇴 시 지워진다. 관리 작업은 receipt와 변경을 D1 batch 트랜잭션으로 처리한다. 권한·서버·채널·원본 메시지·최신 상태를 재검증한다.

## 모집글 사용 방법

모집글에는 참가하기, 참가 취소, 모집 완료, 모집 취소 버튼을 표시한다. ‘모집글 설정’에서 명단 조회, 내용 수정, 대기자 전환·복원, 권한 위임과 위임 응답을 선택한다. 명단은 참가자와 대기자를 나누고 대기 순번을 표시한다.

‘내 최근 모집 복사’는 같은 서버에서 본인이 작성한 최근 글 5개 중 하나를 선택한다. 게임, 모드, 시간, 정원, 역할을 미리보기에서 확인한 뒤 게시하면 새 명단에는 모집자 한 명만 들어간다. ‘내용 수정’은 원본 모집글에서 입력창을 열고 그 글에 변경 사항을 반영한다.

위임 대상은 현재 참가자 중에서 서버 닉네임으로 선택한다. 권한 위임을 확인하면 대상자에게 멘션과 모집글 링크를 담은 DM을 보낸다. 대상자가 15분 안에 ‘위임 응답’에서 수락하면 권한이 이전된다. DM 전달에 실패해도 요청은 유효하다.

## 환경 설정

테스트와 운영은 별도 D1 바인딩과 Discord 앱 설정을 사용한다. 환경별 앱 ID와 공개키를 설정하고 봇 토큰은 Worker Secret으로 관리한다.

## 테스트 환경 적용 절차
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

## 검증 결과

TypeScript 검사와 로컬 테스트 66개를 통과했다. 로컬 D1과 모의 Discord API로 복사 후 명단 분리, 동시 참가 및 대기 처리, 위임 권한 재검증, DM 성공·차단·재전송 방지를 확인했다. 기존 테스트 D1에 추가 마이그레이션을 적용하고 테스트 Worker 배포 후 상태 응답을 확인했다.

전역 명령어 등록과 두 번째 서버의 명령어 노출, 실제 계정의 위임 DM 수신은 별도 점검 항목이다.

## 운영 전환 (별도 확인 필요)
새 운영 D1·Worker·Discord 앱 생성은 사용자의 명시적 확인 이후에 수행한다. 신규 DB에는 스키마만 적용하고 테스트 데이터는 가져오지 않는다. production 자리표시자를 새 DB ID로 바꾸고 별도 운영 앱 설정과 Secret을 넣는다. 테스트 검증한 동일 커밋을 운영으로 배포하며 운영 앱 기준으로 전역 명령어를 별도 동기화한다. 기존 운영/테스트 자원 삭제·초기화는 필요하지 않다. DB 복원은 신규 쓰기 손실을 유발할 수 있으므로 문제 발생 시 먼저 쓰기를 중단하고 백업/Time Travel 시점을 검토한다. 코드만 과거로 되돌리면 새 대기/완료 기능을 무시할 수 있어 구버전 롤백도 별도 검토가 필요하다.
기존 1분 Cron과 게시 동기화 구조를 유지하고 별도 폴링/유료 서비스는 추가하지 않았다. 무료 사용량은 실제 트래픽과 Cloudflare 사용량 화면에서 확인해야 하며 무료 운영을 보장하지 않는다.
