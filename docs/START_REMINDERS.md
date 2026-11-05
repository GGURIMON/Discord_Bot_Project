# 게임 시작 10분 전 알림

예약 시간이 있는 모집은 원본 메시지에 연결된 공개 스레드에서 알림을 받는다. 모집 완료는 참가 접수 마감이므로 대상에 포함한다. 취소되었거나 시간이 종료된 모집, 지금/지금부터, 생성 또는 시간 변경 당시 시작까지 10분 미만인 모집은 제외한다.

날짜 없는 시간은 한국시간 기준 가장 가까운 미래 시각으로 해석한다. 시작과 종료는 UTC epoch 밀리초로 저장하고 표시는 한국시간을 사용한다. 시작을 그대로 두고 정원이나 게임만 편집하면 기존 시작 일시를 보존한다. 복사는 새 모집으로 처리한다.

## 스케줄과 중복 방지

기존 Wrangler Cron 설정 `* * * * *`와 scheduled 핸들러를 사용한다. 시작 10분 전부터 최대 5분 동안 밀린 작업을 처리한다. 만료된 알림을 다음 날 재발송하지 않는다. 한 번에 두 모집을 처리하므로 동시에 몰린 모집은 처리 창을 넘겨 생략될 수 있다.

0004 마이그레이션은 독립된 재시도·선점 상태를 보관하는 start_reminders 테이블, 부분 인덱스와 트리거를 추가한다. 기존 모집은 정수 UTC 시작 일시와 한국시간 표기가 일치하고 아직 예약 가능한 경우만 채운다. 예약 변경은 기존 일정을 재계산한다. 이미 발송됐거나 일부 전송된 모집, 전송 결과가 불확실한 모집은 새 시간에 다시 처음부터 알리지 않는다.

작업의 선점은 조건부 UPDATE로 처리한다. 스레드 ID는 원본 메시지 ID와 같으므로 생성 응답이 유실돼도 부모 채널과 서버를 확인하고 복구한다. 첫 전송 직전에 participants를 읽어 확정 명단을 고정하며 대기는 제외한다. 최대 75명씩 전송하며 매번 진행 위치를 저장한다. 사용자 멘션만 명시적으로 허용한다. 역할이나 전체 멘션을 허용하지 않는다.

Discord 요청 실패는 last_error 및 start_reminder_failed 로그에 남긴다. 429는 retry_after를 지키며 다음 Cron에서 처리한다. 실패한 단계는 최대 네 번 시도한다. 권한 부족이나 삭제된 원본은 중단한다. 메시지 전송은 페이지별 nonce를 재사용한다. 결과가 불명확한 채 2분 이상 경과하면 중복 알림 방지를 위해 자동 재전송을 중단한다. 외부 API 전송과 D1 쓰기는 하나의 트랜잭션이 아니므로 실패 시 수동 확인이 필요할 수 있다.

## 로컬 검증

`npm ci` 후 `npm run check`로 전체 회귀 테스트를 실행한다. `npx vitest run tests/reminders.test.ts`는 로컬 D1에서 주입한 시계를 자정·알림 시점·재시도 시점으로 이동시킨다. Discord 호출도 모의 처리하므로 실제 게임 시작이나 Cron을 기다릴 필요가 없다.

## 배포 전

1. 테스트 D1을 백업하고 기존 마이그레이션 이력을 확인한다. 테스트 환경에 먼저 `npx wrangler d1 migrations apply DB --remote --env staging` 후 같은 커밋의 Worker를 배포한다.
2. 서버 텍스트 채널에서 View Channel, Read Message History, Send Messages, Create Public Threads, Send Messages in Threads를 확인한다. 채널별 권한 덮어쓰기도 확인한다. 공개 스레드를 만들 수 있는 일반 텍스트 채널을 지원한다.
3. 12분 이상 뒤의 모집을 생성해 원본 글과 버튼, 스레드 한 개, 확정 참가자 멘션, 실제 클라이언트 알림을 확인한다. 기존 Cron Triggers 화면에서 1분 간격을 확인한다.
4. 운영은 별도 승인 후 운영 D1 백업, 대상 바인딩 확인, 마이그레이션, Worker 배포 순으로 진행한다. 저장소의 deploy.yml은 main에서 수동 실행할 때 운영 마이그레이션과 배포를 함께 수행한다. Cloudflare 대시보드의 Git 연결 및 branch filters도 배포 전에 확인한다.

[Discord 채널 및 스레드 API](https://docs.discord.com/developers/resources/channel) · [메시지 및 allowed_mentions](https://docs.discord.com/developers/resources/message) · [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
