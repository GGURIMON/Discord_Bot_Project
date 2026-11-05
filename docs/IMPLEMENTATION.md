# 구현 결과 및 검증 기록

2026-11-05 기준. 사용자가 개인 패널 입력, 확인 버튼 활성화, 인원 연동과 정원 차단을 확인하고 코드 작성을 승인하여 구현했다.

## 완료한 범위

| 단계 | 파일 | 내용 |
| --- | --- | --- |
| 기본 환경 | package.json, package-lock.json, tsconfig.json, wrangler.jsonc, src/index.ts, src/security.ts | TypeScript Worker, 환경 분리, Ed25519, PING, 빠른 초기 응답 |
| 모집 생성 | src/interactions.ts, src/components.ts, src/domain.ts, src/config/games.ts | 개인 패널, 메뉴, 모달, 게임 복수/직접 입력, 모드, 시간, 정원, 역할, 유효 입력 시 확인 버튼 활성화 |
| 참가 관리 | migrations/0001_initial.sql, src/database/repository.ts | 작성자 자동 참가, 원자적 정원 관리, 중복 방지, 취소와 재개방, 작성자 전체 취소 |
| 안정화 | src/services/discord.ts, src/services/sync.ts | rate limit, 백오프, 영속 작업, 갱신 lease, 멱등성, 버전 재검사, 주기적 재동기화 |
| 배포 준비 | .github/workflows, scripts/register-commands.mjs, .dev.vars.example | 수동 검사, 수동 승인 운영 배포, 명령어 등록 스크립트, 설정 예시 |
| 문서 | README.md, docs/OPERATIONS.md | 로컬 실행, 외부 설정, 배포, 무료 한도, 장애 복구 |

## 실행한 검증

- Node.js 26.12.1 로컬 환경에서 `npm run check`: 타입 검사 통과, 테스트 3개 파일 총 41개 통과.
- `npm run build`: Wrangler dry-run 통과. 실제 업로드/배포 없음. 최종 번들 약 38.31 KiB, gzip 약 10.29 KiB.
- `.dev.vars`, `.env`, `.wrangler`, node_modules, dist가 Git 제외 대상인지 확인.
- 설치 시 npm audit: 알려진 취약점 0개. 이 결과는 설치 시점과 해당 패키지 집합에 한정한다.

D1 통합 테스트는 Miniflare/workerd의 로컬 D1을 사용했다. Discord HTTP는 모의 응답이다. CI용 권장 버전은 Node 24이며 GitHub hosted runner에서의 실행은 아직 하지 않았다. Miniflare 버전은 현재 Wrangler가 사용하는 5.20261103.0-beta와 일치시켜 고정했고 모든 패키지는 lockfile로 재현한다.

## 요구사항의 최소 18개 시나리오

| 시나리오 | 검증 |
| --- | --- |
| 1 단일 게임 | domain.test.ts 일반 본문 출력 |
| 2 복수 게임 | domain.test.ts 및 integration.test.ts 개인 패널→게시 |
| 3 게임별 모드 | 복수 게임별 설명 및 직접 입력 |
| 4 시간 형식 | 잘못된 HH:mm, 과거 시간, 동일 시간, 자정 경계 |
| 5 역할 단일 멘션 | 최초 POST의 allowed_mentions |
| 6 역할 복수 멘션 | 패널→복수 Role Select→게시 |
| 7 작성자 자동 참가 | 생성 직후 member_count=1 |
| 8 정상 참가 | 등록과 본문 [2/4] 갱신 |
| 9 중복 참가 | 동일 사용자 및 같은 interaction 동시 요청 |
| 10 참가 취소 | 삭제 후 인원 감소 |
| 11 정원 마감 | 정원 1명 및 4명, 버튼 비활성화 |
| 12 취소 후 재개 | 참가 버튼 재활성화 |
| 13 동시 참가 | 20개 병렬 요청, 모집자 외 3명만 성공 |
| 14 모집자 취소 | 상태 변경, 취소 표시, 모든 버튼 차단 |
| 15 타인 취소 시도 | not_owner, 다른 서버/채널/메시지 거부 |
| 16 잘못된 서명 | 401, 본문 변조 및 오래된 서명 거부 |
| 17 API 오류 | 500 재시도, 403 차단, 429 대기, 최초 게시 응답 유실 |
| 18 수정 시 재알림 방지 | 모든 PATCH의 allowed_mentions 비움 |

추가로 draft 만료/소유자/오래된 버전, 동시 게시, DB 직접 초과 INSERT, batch 실패 전체 롤백, 갱신 도중 새 참가, 작업 없는 표시 재동기화, 삭제된 역할, 오래된 불확실 게시의 자동 재전송 차단을 검증했다.

## 아직 필요한 외부 검증

실제 Discord의 메뉴/모달 렌더링과 역할 알림 도달, Cloudflare 원격 D1 및 무료 CPU 한도, GitHub Actions 실행은 계정 연결과 staging 배포 후 검증해야 한다. 로컬 테스트 통과를 실제 서버 검증 완료로 취급하지 않는다. 이후 staging 배포와 GitHub 업로드를 완료했다. 실제 클라이언트 검증은 테스트 서버에서 별도로 진행한다.
