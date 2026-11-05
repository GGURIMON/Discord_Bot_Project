# 운영 및 장애 복구

## 상태 확인

- `/health`는 Worker 응답만 확인한다. DB/Discord 연결까지 확인하는 endpoint는 아니다.
- Cloudflare 로그의 `message_sync_retry`, `message_sync_blocked`, `interaction_reply_failed`와 오류 코드를 확인한다. 로그는 token, Authorization 헤더, 전체 interaction 본문을 남기지 않는다.
- `message_jobs`의 blocked/attempts/last_error_code를 확인한다. 처음 게시하지 못했거나 결과가 불확실하면 모집 status가 publish_failed가 된다.
- 역할 삭제/mentionable 변경은 최초 게시 전에 검증하며 `role_unavailable`로 멈춘다.

## 인원은 저장됐으나 메시지가 갱신되지 않을 때

1. 모집 DB의 message_id와 실제 메시지를 비교한다.
2. `discord_403`이면 채널 보기/메시지 보내기 권한을 복구한다. `discord_404`면 메시지 삭제 여부를 확인한다. 삭제된 공개 모집은 자동 재게시하지 않는다.
3. 권한 복구 후 해당 message_jobs 행의 blocked=0, attempts=0, next_attempt_at=0, lease_owner=NULL, lease_expires_at=0으로 변경하면 다음 Cron이 최신 DB 상태를 반영한다. first_attempt_at은 이미 게시된 메시지 갱신과 무관하다.
4. 진행 중이거나 종료 후 24시간 이내인 모집은 10분 주기의 재동기화 대상이다. Cron 실행당 최대 5건을 예약하므로 모집이 많으면 더 늦어질 수 있다. 더 오래된 기록을 복구하려면 모집 ID의 message_jobs 행을 추가한다. 운영 DB 수정은 대상 모집을 확인하고 진행한다.

## 최초 게시 결과 불명확

`publish_ambiguous`는 API 요청이 처리됐는지 알 수 없고 nonce 유효 기간을 넘겼다는 뜻이다. 채널의 실제 모집 메시지를 먼저 찾는다. 자동 재게시로 역할 알림을 반복하지 않는다.

- 메시지가 존재하면 버튼 custom_id의 모집 ID가 일치하는지 확인한 후 DB message_id를 연결하고 status를 open으로 복구한다. 이미 종료 시각을 넘겼다면 ended로 설정한다. 작업을 다시 활성화하면 최신 인원과 비활성화 상태로 갱신한다.
- 메시지가 없다는 것을 확인했다면 해당 실패 모집은 기록으로 남기고 `/모집`을 다시 실행한다.
- `publish_expired`는 게시 전에 종료 시각이 지난 경우다. 새 시간으로 모집을 작성한다.

메시지 조회·DB 수정은 운영자 권한 작업이다. 자동화된 관리 명령어는 이번 버전에 포함하지 않았다.

## 보존과 한도

작성 상태는 15분 만료 후 하루가 지나면 정리한다. interaction 결과는 7일 후 정리한다. 요청 서명은 5분 시각 오차 제한을 두어 오래된 재생을 막는다. Cron은 실행마다 각각 최대 100개 만료 행과 50개 종료 모집을 처리한다.

모집과 참가 이력은 자동 삭제하지 않는다. D1 사용량을 정기 확인하고 보존 기간을 별도로 정한다. 쓰기 행 수에는 인덱스/트리거 변경도 영향을 주므로 버튼 클릭 수와 동일하지 않다. 429는 retry_after를 반영하며 일시적 오류는 제한된 백오프로 재시도한다. 반복 실패는 차단 상태로 남겨 운영자가 확인한다.

## 배포와 롤백

staging과 production DB를 분리하고 migration 파일은 적용 후 수정하지 않는다. 변경은 새 migration으로 추가한다. 파괴적인 스키마 변경은 별도 백업과 확인이 필요하다. Worker 이전 버전으로 롤백해도 D1 migration이 자동 취소되지는 않으므로 하위 호환 스키마 변경을 우선한다.

실제 Discord 검증 체크리스트: 개인 패널 비공개, 체크 버튼 활성화, 게임 복수/직접 입력, 역할 복수 실제 알림, 참가/취소 숫자, 정원 마감/재개, 타인 모집 취소 거부, 자정 이후 종료, 재시작 후 버튼 동작, 15분 이후에도 기존 모집 갱신.
