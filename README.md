# Discord 게임 모집 봇

`/모집`으로 나에게만 보이는 입력 패널을 열고, 게임·시간·최대 인원을 입력하면 **✅ 모집 게시** 버튼이 활성화된다. 게시된 일반 메시지에서 참가와 취소를 누르면 인원이 반영되고, 정원이 차면 참가 버튼이 잠긴다. 빈자리가 생기면 다시 열린다.

```text
게임 이름 / 13:00 ~ 14:30 / [1/4] / @FPS(모든장르), @스팀(모든장르)
[참가하기] [참가 취소] [모집 취소]
```

TypeScript · Cloudflare Workers · D1 · Discord HTTP Interactions를 사용한다. Gateway 연결이나 개인 PC 상시 실행은 필요하지 않다. 현재 저장소는 로컬 구현이며, 실서버 사용에는 아래 외부 설정과 배포가 필요하다.

## 사용자 흐름

1. 서버 채널에서 `/모집` 실행.
2. `모집 내용 입력`을 누르고 게임명을 직접 쓴다. 모드를 함께 적거나 줄마다 다른 게임을 적을 수 있다.
3. 시간에는 `지금`, `지금부터`, `13:00` 또는 `13:00 ~ 14:30`을 쓰고 모집자를 포함한 정원을 입력한다.
4. 모집 내용 입력 창에서 서버의 게임 알림 역할을 복수 선택한다. 비워 두면 멘션 없이 게시한다.
5. 미리보기를 확인하고 활성화된 `✅ 모집 게시` 클릭.
6. 모집자는 자동으로 첫 참가자. 정원이 1명이면 바로 참가 마감.
7. 모집자 본인의 참가만 취소할 수는 없으며, `모집 취소` → 개인 확인 버튼으로 전체 모집을 취소.

모든 시간은 한국 시간이다. 시간 범위는 종료 전까지 게시할 수 있고 종료가 시작보다 이르면 다음 날로 해석한다. 종료 생략 시 시작 후 24시간에 참가를 마감하고 공개 본문에는 입력한 시간만 표시한다. 작성 패널은 15분 후 만료된다.

역할은 기존 역할 ID로 처리한다. 멘션이 제한된 일반 역할도 본문에 표시하며 역할 생성·부여·삭제는 하지 않는다. 최초 게시에만 선택 역할을 `allowed_mentions`로 허용한다. 이후 수정은 모든 멘션 알림을 차단한다. 실제 알림 도달 여부는 Discord의 개인 알림 설정에도 영향을 받는다.

## 로컬 실행

Node.js 24 LTS와 npm을 사용한다. Node 16은 지원하지 않는다. `.nvmrc`가 있으면 `nvm use`로 버전을 맞춘다.

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

`.dev.vars`의 값을 채운다. 이 파일은 Git에서 제외되며 채팅이나 저장소에 토큰을 붙이지 않는다.

| 설정 | 용도 |
| --- | --- |
| DISCORD_APPLICATION_ID | Discord 애플리케이션 ID |
| DISCORD_PUBLIC_KEY | Interaction 서명 검증용 공개키 |
| DISCORD_BOT_TOKEN | 모집글 생성·수정용 봇 토큰 |
| DISCORD_GUILD_ID | 개발 서버의 `/모집` 등록용 서버 ID |

`GET /health`는 프로세스 확인, `POST /interactions`는 서명된 Discord 요청 수신용이다. Discord는 로컬 주소에 직접 접근할 수 없으므로 실제 클라이언트 검증은 HTTPS staging Worker에서 진행한다.

```sh
npm run check   # 타입 검사 + 단위/로컬 D1 통합 테스트
npm run build   # 배포 없이 Worker 번들만 검증
```

테스트는 Miniflare의 실제 로컬 D1을 사용한다. 임시 로컬 포트를 열기 때문에 제한된 실행 환경에서는 포트 사용 승인이 필요하다. 테스트의 Discord API는 가짜 HTTP 서버 응답으로 대체되며 외부 채널에 메시지를 보내지 않는다.

## Discord와 Cloudflare 최초 설정

아래 단계는 외부 계정·서버 설정을 바꾼다. 사용자 확인 후 실행한다.

1. Discord Developer Portal에서 애플리케이션과 봇을 준비한다. 공개키, 애플리케이션 ID, 봇 토큰을 각 환경에 설정한다.
2. 서버에 `bot`, `applications.commands` 범위로 설치하고 `채널 보기`, `메시지 보내기` 권한을 부여한다. 기본 구현은 일반 텍스트 채널을 대상으로 한다. 역할 관리·서버 관리자·Message Content Intent는 필요하지 않다.
3. Cloudflare 무료 계정에 D1을 생성한다. `wrangler.jsonc`의 staging/production DB ID와 vars를 실제 값으로 바꾼다. 두 환경의 DB는 반드시 분리한다. 최상위 설정의 0 UUID는 로컬용이다.

```sh
npx wrangler login
npx wrangler d1 create discord-party-staging
npx wrangler d1 create discord-party-production
npx wrangler secret put DISCORD_BOT_TOKEN --env staging
npx wrangler secret put DISCORD_BOT_TOKEN --env production
npx wrangler d1 migrations apply DB --remote --env staging
npx wrangler deploy --env staging
```

4. Developer Portal의 Interactions Endpoint URL을 `https://<staging-worker>.workers.dev/interactions`로 설정한다. 공개키와 app ID가 맞으면 PING 검증에 응답한다.
5. `.dev.vars`에 개발 서버 ID를 넣고 아래 명령을 실행한다. 같은 이름의 `/모집`만 등록/갱신하며 다른 명령어는 삭제하지 않는다.

```sh
npm run commands:register
```

6. 실제 Discord에서 입력 메뉴·모달·역할 알림·동시 참가·취소를 검증한다. staging과 production을 동시에 쓸 때는 서로 다른 Discord 애플리케이션을 권장한다. 하나의 애플리케이션에는 하나의 Interaction endpoint만 설정할 수 있다.
7. 검증 후 운영 DB 마이그레이션과 Worker 배포, 운영 Discord endpoint 전환을 진행한다.

## CI/CD와 GitHub

현재 폴더에는 Git이 초기화되어 있다. 원격 저장소 연결과 push는 아직 수행하지 않았다.

GitHub Actions를 사용한다. PR/main push에서 `npm run check`와 dry-run 빌드를 실행한다. 운영 배포는 Actions의 **승인된 운영 배포**를 main에서 수동 실행한다. 워크플로가 검사, D1 migration, 배포 순서를 자동 수행한다. 사용자 승인 없는 최초 외부 배포를 피하기 위해 push만으로 운영 배포가 시작되지는 않는다.

GitHub의 `production` Environment에 배포용 최소 권한 `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`를 저장한다. 환경 승인 기능을 사용할 수 있으면 required reviewers를 설정한다. 워크플로의 `environment` 선언만으로 승인자가 자동 설정되지는 않으며, 계정/저장소 유형에 따라 해당 기능의 제공 범위가 다르다. 지원하지 않으면 workflow_dispatch 실행 권한으로 승인 단계를 관리한다. Bot Token은 Cloudflare Secrets에 둔다.

## 구조와 안정성

```text
src/
  index.ts                 서명 검증, 초기 defer, Cron
  interactions.ts          명령어/메뉴/모달/버튼 흐름
  components.ts            개인 패널과 일반 모집글
  domain.ts                게임·모드·시간·인원 검증
  config/games.ts           수정 가능한 게임 목록
  database/repository.ts   D1 트랜잭션과 멱등 처리
  services/discord.ts      제한 시간과 오류 분류를 둔 Discord HTTP API
  services/sync.ts         영속 작업, 재시도, 모집별 갱신 잠금
migrations/                D1 스키마와 제약
tests/                     단위/서명/로컬 D1 통합 테스트
scripts/                   명령어 등록
docs/                      설계와 운영 안내
```

한 모집에 최대 25게임과 25역할을 입력할 수 있다. 공개 본문은 2,000자 한도 안에서 검증한다.

참가 판정과 INSERT/DELETE, interaction 결과 저장은 D1 `batch()` 트랜잭션이다. 중복 참가 UNIQUE 제약, 정원·상태 검사 트리거, 작성자 삭제 방어가 DB에도 적용된다. 같은 interaction 재전송은 기존 결과만 반환한다. 참가 변경 트리거는 메시지 갱신 작업도 같은 트랜잭션에 기록한다.

DB 상태가 기준이며 Discord API와 원자적 커밋은 불가능하다. 보통 버튼 클릭 직후 갱신하지만, 실패하면 Cron이 저장된 작업을 재시도한다. 모집별 lease와 버전 검사를 사용해 갱신 충돌을 줄인다. 진행 중/종료 후 24시간 이내 모집은 10분 주기로 재동기화 대상에 넣어 늦게 도착한 HTTP 요청으로 생긴 표시 오류도 복구한다. 네트워크 지연 시 일시적으로 오래된 인원수가 표시될 수 있어도 DB 정원은 초과하지 않는다.

최초 게시에는 nonce를 사용한다. Discord가 nonce 중복 방지를 보장하는 기간은 최근 몇 분이므로 2분 이상 결과가 불명확한 게시를 자동으로 반복하지 않는다. 이 경우 운영자가 실제 메시지를 확인해야 한다. 자세한 절차는 [운영 안내](docs/OPERATIONS.md)를 참고한다.

## 무료 한도

2026-11-05 공식 문서 기준 Workers Free 일 100,000 요청/요청 CPU 10ms, D1 Free 일 500만 읽기 행/10만 쓰기 행/합계 5GB다. 테스트는 무료 플랜의 실사용 CPU·요청 한도나 알림 도달을 검증하지 않는다. 실제 사용량을 계측하고 유료 전환은 사전 확인한다. Cron은 1분 간격, 실행당 갱신 작업 5건으로 제한된다. 장기간 모집 이력은 자동 삭제하지 않아 저장량 점검이 필요하다.

공식 문서: [Discord 컴포넌트](https://docs.discord.com/developers/components/reference), [Interaction 응답](https://docs.discord.com/developers/interactions/receiving-and-responding), [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/), [Workers 한도](https://developers.cloudflare.com/workers/platform/limits/), [D1 요금](https://developers.cloudflare.com/d1/platform/pricing/).
