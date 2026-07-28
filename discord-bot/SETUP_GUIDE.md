# Discord Bot 등록 및 설정 가이드

이 가이드는 Skald Discord Bot을 Discord에 등록하고 필요한 설정을 완료하는 방법을 설명합니다.

## 목차

1. [Discord Application 생성](#1-discord-application-생성)
2. [Bot 생성 및 토큰 발급](#2-bot-생성-및-토큰-발급)
3. [권한 및 인텐트 설정](#3-권한-및-인텐트-설정)
4. [Bot을 서버에 초대](#4-bot을-서버에-초대)
5. [Skald Discord Bot 설정](#5-skald-discord-bot-설정)
6. [배포 및 실행](#6-배포-및-실행)

---

## 1. Discord Application 생성

### 1.1 Discord Developer Portal 접속

1. 브라우저에서 [Discord Developer Portal](https://discord.com/developers/applications)에 접속합니다.
2. Discord 계정으로 로그인합니다.

### 1.2 New Application 생성

1. **"New Application"** 버튼을 클릭합니다.
   ![New Application](https://i.imgur.com/your-image-1.png)

2. 애플리케이션 이름을 입력합니다.
    - 예: `Skald Bot` 또는 원하는 이름
    - **주의**: 이 이름은 나중에 변경할 수 있습니다.

3. **"Create"** 버튼을 클릭합니다.

### 1.3 기본 정보 확인

- **APPLICATION ID**: 나중에 Bot 초대 링크 생성 시 필요합니다.
- **PUBLIC KEY**: Webhook이나 Interactions에 사용됩니다 (선택사항).

---

## 2. Bot 생성 및 토큰 발급

### 2.1 Bot 설정 페이지 이동

왼쪽 사이드바에서 **"Bot"** 메뉴를 클릭합니다.

### 2.2 Bot 생성

1. **"Add Bot"** 버튼을 클릭합니다.
2. **"Yes, do it!"** 버튼으로 확인합니다.

### 2.3 Bot 설정

- **USERNAME**: Bot의 표시 이름을 설정합니다.
    - 예: `Skald Bot`
- **ICON**: Bot의 프로필 사진을 업로드합니다 (선택사항).

### 2.4 Token 발급 ⚠️ 중요

1. **"TOKEN"** 섹션에서 **"Reset Token"** 버튼을 클릭합니다.
2. **"Copy"** 버튼을 클릭하여 토큰을 복사합니다.

> ⚠️ **경고**: 이 토큰은 **절대 공개되면 안 됩니다**.
>
> - GitHub, Discord 채팅 등에 노출하지 마세요.
> - 토큰이 유출되면 즉시 재발급하세요.
> - `.env` 파일에 저장하고 `.gitignore`에 추가하세요.

---

## 3. 권한 및 인텐트 설정

### 3.1 Privileged Gateway Intents 활성화

Bot 페이지 하단의 **"Privileged Gateway Intents"** 섹션에서 다음을 활성화합니다:

- ✅ **MESSAGE CONTENT INTENT**
    - 메시지 내용을 읽기 위해 필요합니다.
    - 사용자가 Bot을 멘션할 때 메시지 내용을 파싱하는 데 사용됩니다.

> ⚠️ **주의**: 100개 이상의 서버에 Bot을 추가하려면 Discord에 추가 검증이 필요합니다.

### 3.2 기본 권한 설정

**"Bot Permissions"** 섹션에서 다음 권한을 활성화합니다:

#### 필요한 권한:

```
General Permissions:
  - View Channels
  - Read Messages/View Channels

Text Permissions:
  - Send Messages
  - Send Messages in Threads
  - Create Public Threads
  - Embed Links
  - Attach Files
  - Read Message History
  - Mention @everyone, @here, and All Roles
  - Add Reactions
  - Use External Emojis
  - Use External Stickers

Message Content:
  - Read Message Content (Privileged Intent 필요)
```

---

## 4. Bot을 서버에 초대

### 4.1 OAuth2 URL 생성

왼쪽 사이드바에서 **"OAuth2"** → **"URL Generator"**를 클릭합니다.

### 4.2 Scope 선택

**"SCOPES"** 섹션에서 선택:

- ✅ **bot**
- ✅ **applications.commands** (슬래시 커맨드 사용 시)

### 4.3 Bot Permissions 선택

**"BOT PERMISSIONS"** 섹션에서 선택:

```
General:
  - View Channels

Text:
  - Send Messages
  - Send Messages in Threads
  - Create Public Threads
  - Manage Messages
  - Manage Threads
  - Embed Links
  - Attach Files
  - Read Message History
  - Mention Everyone
  - Add Reactions
  - Use External Emojis
  - Use External Stickers
  - Read Message Content
```

### 4.4 생성된 URL로 초대

1. 하단의 **"GENERATED URL"**을 복사합니다.
2. 브라우저에서 해당 URL로 이동합니다.
3. 초대할 서버를 선택합니다.
4. **"Authorize"** 버튼을 클릭합니다.
5. **"I am not a robot"** 캡차를 완료합니다.

---

## 5. Skald Discord Bot 설정

### 5.1 환경 변수 설정

프로젝트 루트에서 `.env` 파일을 생성합니다:

```bash
cd discord-bot
cp .env.example .env
```

### 5.2 .env 파일 구성

```env
# Discord Bot Token (2.4에서 발급받은 토큰)
DISCORD_BOT_TOKEN=YOUR_DISCORD_BOT_TOKEN_HERE

# Skald API 설정
SKALD_API_URL=http://api-server:8000
SKALD_API_KEY=your_skald_api_key_here
SKALD_PROJECT_ID=your_skald_project_id_here

# 로그 레벨 (debug, info, warn, error)
LOG_LEVEL=info
```

### 5.3 K8s Secret 생성 (Kubernetes 배포 시)

```bash
# 먼저 Secret 파일 생성
cat > k8s/discord-bot-secret.local.yaml << EOF
apiVersion: v1
kind: Secret
metadata:
  name: discord-bot-secrets
  namespace: skald
  labels:
    app: skald
    component: discord-bot
type: Opaque
stringData:
  DISCORD_BOT_TOKEN: "YOUR_DISCORD_BOT_TOKEN_HERE"
  SKALD_API_KEY: "your_skald_api_key_here"
  SKALD_PROJECT_ID: "your_skald_project_id_here"
EOF

# Secret 적용
kubectl apply -f k8s/discord-bot-secret.local.yaml
```

> ⚠️ **경고**: `discord-bot-secret.local.yaml`은 `.gitignore`에 포함되어 Git에 커밋되지 않습니다.

---

## 6. 배포 및 실행

### 6.1 로컬에서 실행

```bash
cd discord-bot

# 의존성 설치
pnpm install

# 개발 모드 실행
pnpm run dev
```

### 6.2 Docker로 빌드 및 실행

```bash
cd discord-bot

# Docker 이미지 빌드
docker build -t skald-discord-bot:latest .

# Docker 컨테이너 실행
docker run -d \
  --name discord-bot \
  --env-file .env \
  -p 3000:3000 \
  skald-discord-bot:latest
```

### 6.3 Kubernetes에 배포

```bash
# K8s 디렉토리로 이동
cd k8s

# 배포 스크립트 실행 (Discord Bot 포함)
./deploy.sh

# 또는 Discord Bot만 배포
kubectl apply -f discord-bot-configmap.yaml
kubectl apply -f discord-bot-secret.local.yaml
kubectl apply -f discord-bot-deployment.yaml
kubectl apply -f discord-bot-service.yaml

# 상태 확인
kubectl get pods -n skald -l component=discord-bot
kubectl logs -f deployment/discord-bot -n skald
```

---

## 7. 테스트 및 검증

### 7.1 Bot이 온라인인지 확인

Discord 서버에서 Bot 사용자가 **온라인** 상태인지 확인합니다.

### 7.2 슬래시 커맨드 테스트

서버의 채팅 채널에서 다음 명령어를 입력합니다:

```
/help
```

**예상 결과**: Skald Bot 도움말 Embed가 표시됩니다.

```
/config
```

**예상 결과**: 현재 설정된 Skald API 정보가 표시됩니다.

### 7.3 멘션 테스트

Bot을 멘션하고 질문합니다:

```
@Skald Bot 안녕하세요!
```

**예상 결과**:

1. ⏳ 답변을 생성하고 있습니다..." 메시지 표시
2. 1초 간격으로 메시지 업데이트
3. 최종 답변과 함께 참고 자료 Embed 표시

---

## 8. 문제 해결

### 8.1 Bot이 응답하지 않는 경우

```bash
# 로그 확인
kubectl logs -f deployment/discord-bot -n skald

# Pod 상태 확인
kubectl get pods -n skald -l component=discord-bot

# 환경 변수 확인
kubectl exec -it deployment/discord-bot -n skald -- env | grep DISCORD
```

### 8.2 일반적인 오류

| 오류 메시지             | 원인                            | 해결 방법                           |
| ----------------------- | ------------------------------- | ----------------------------------- |
| `Disallowed intent`     | MESSAGE CONTENT INTENT 미활성화 | Discord Developer Portal에서 활성화 |
| `Authentication failed` | 잘못된 토큰                     | 토큰 재발급 및 업데이트             |
| `Connection reset`      | 네트워크 문제                   | 인터넷 연결 확인, 재시도            |
| `429 Too Many Requests` | Rate limit 초과                 | 잠시 후 재시도                      |

### 8.3 Intent 설정 확인

Discord Developer Portal에서 다음이 활성화되어 있는지 확인:

- ✅ **SERVER MEMBERS INTENT** (필요한 경우)
- ✅ **MESSAGE CONTENT INTENT** (필수)
- ✅ **PRESENCE INTENT** (필요한 경우)

---

## 9. 추가 설정 (선택사항)

### 9.1 Rich Presence 설정

Bot의 상태 메시지를 커스터마이징하려면 `discord-bot/src/index.ts`를 수정하세요:

```typescript
client.user.setActivity('/help로 도움말 확인', { type: ActivityType.Listening })
```

### 9.2 명령어 권한 제한

특정 역할만 명령어를 사용할 수 있도록 설정하려면:

```typescript
// commands/help.ts
export async function execute(interaction: ChatInputCommandInteraction) {
    // 관리자 권한 확인
    if (!interaction.memberPermissions?.has('Administrator')) {
        await interaction.reply({
            content: '이 명령어는 관리자만 사용할 수 있습니다.',
            ephemeral: true,
        })
        return
    }
    // ... 명령어 로직
}
```

### 9.3 로깅 수준 조정

`.env` 파일에서 `LOG_LEVEL`을 조정합니다:

```env
# 디버깅 시
LOG_LEVEL=debug

# 프로덕션
LOG_LEVEL=info
```

---

## Hermes 전환 상태

이 디렉터리의 Node/Discord.js bot은 Hermes production cutover 이후 **rollback-only**입니다. soak 기간에는 이미지, Kubernetes manifest, compatible ConfigMap/Secret contract와 소스를 유지하며 삭제하지 않습니다. 별도 decommission 승인 전에는 production 기능을 이 코드에 추가하거나 Hermes와 같은 production Discord token으로 동시에 실행하지 않습니다.

Production 목표는 Skald-owned Kubernetes Hermes 이미지이며 실행 argv는 정확히 `hermes gateway run`입니다. Discord 멘션, 스레드, 첨부, 메시지 전달 정책은 Hermes native Discord policy가 정본입니다. 기존 bot의 general RAG, product filter, reference/citation, preview/progress, streaming/partial-response 동작은 functional-spec-only Hermes scope에서 의도적으로 parity 대상이 아닙니다. readiness도 이 기존 동작을 묶어 검증하는 compound readiness가 아닙니다.

운영 순서는 `commit` → `push` → `.github/workflows/build-hermes-gateway.yml` Actions 성공과 digest 확인 → immutable `HERMES_IMAGE=...@sha256:...` 설정 → `HERMES_DEPLOY_MODE=cutover|upgrade|rollback`으로 `k8s/deploy.sh -y` 실행입니다. tag-only 이미지나 `latest`는 Hermes 배포 입력으로 사용하지 않습니다.

Cutover/upgrade/rollback은 precreated non-expiring operation Lease, durable active-owner index, immutable snapshots를 사용합니다. 모호한 Kubernetes write/readback/release는 `RECOVERY_REQUIRED`로 fail closed하며 자동 rollback이나 lock clear를 하지 않습니다. recovery는 privileged audit 절차가 필요합니다. Hermes soak 중 결론적인 장애에는 retained legacy snapshot으로 rollback할 수 있지만, legacy workload는 평상시 production owner가 아닙니다.

### 수용된 잔여 위험

다음 항목은 해결되었다는 의미가 아니라 명시적으로 수용한 범위입니다.

- Hermes native policy와 native attachment/message behavior는 legacy bot과 다를 수 있습니다.
- compound policy/readiness 및 Discord API session-exclusivity proof는 제공하지 않습니다.
- `sparrow-function-spec`의 credential 처리, TLS bypass/default, updater/install 동작은 변경하지 않습니다.
- Calico, NetworkPolicy, proxy 및 cluster egress는 변경하지 않습니다.
- abandoned 또는 ambiguous operation은 audited manual recovery까지 배포를 무기한 잠글 수 있습니다.

## 참고 자료

- [Discord.js Guide](https://discordjs.guide/)
- [Discord Developer Documentation](https://discord.com/developers/docs/intro)
- [Discord Developer Portal](https://discord.com/developers/applications)

---

## 요약 체크리스트

- [ ] Discord Application 생성
- [ ] Bot 생성 및 Token 발급
- [ ] MESSAGE CONTENT INTENT 활성화
- [ ] OAuth2 URL 생성 및 서버 초대
- [ ] `.env` 파일에 Token 설정
- [ ] K8s Secret 생성 (Kubernetes 사용 시)
- [ ] `/help`, `/config` 명령어 테스트
- [ ] `@Bot 질문` 멘션 테스트

---

**문제가 있으면 Slack #skald-support 채널에 문의하세요!**
