# FRONTEND SOURCE DOMAIN

**Generated:** 2026-04-29
**Domain:** UI Runtime (`frontend/src`) (Score 18)

## OVERVIEW

루트 패키지가 곧 프론트엔드인 inverted 구조입니다. 이 디렉터리는 라우팅, 상태, API 호출 규칙의 실제 기준점입니다.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| App bootstrap | `main.tsx`, `App.tsx` | Vite + React + Sentry/PostHog gate |
| Routing | `routes.tsx`, `pages/` | private/public route composition |
| API client | `lib/api.ts` | raw fetch/axios 금지, CSRF/SSE 포함 |
| Shared types | `lib/types.ts` | backend DTO와 맞춰 유지 |
| Shared state | `stores/*.ts` | Zustand store layer |
| UI components | `components/` | shadcn/Radix primitives + feature folders |
| Styling | `styles/global.scss`, Tailwind classes | `cn()` utility pattern |
| Runtime config | `config.ts` | self-host/public deployment flags |

## CONVENTIONS (DEVIATIONS ONLY)

- Root `package.json` owns frontend commands: `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm preview`.
- Alias is `@/* -> frontend/src/*`.
- API domain defaults to same-origin `/api` when `VITE_API_HOST` is empty; local preview without API proxy will 404 public wiki calls.
- Shared state goes through `stores/`; local `useState` is fine only for transient UI state.
- Chat/public-chat preview SSE events are promoted by stores when the first assistant bubble is still empty.

## ANTI-PATTERNS

- Components/pages must not import `axios` or call `fetch` directly.
- Do not persist `userContext`; `chatStore` keeps it runtime-only and excludes it from persisted state.
- Do not place heavy data orchestration in pages; pages should compose stores/components.
- Do not hardcode model endpoint URLs in frontend config.

## NOTES

- Public wiki route is under `/public/wiki/:slug` and shares the public-chat project gate.
- Self-hosted deployments skip PostHog/Sentry tracking in `main.tsx`.
