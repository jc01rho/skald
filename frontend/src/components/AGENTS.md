# FRONTEND COMPONENTS

**Generated:** 2026-04-29
**Domain:** Core UI (Score 15)

## OVERVIEW

Reusable shadcn/Radix primitives plus feature-specific React component folders.

## WHERE TO LOOK

| Area | Location | Notes |
| --- | --- | --- |
| Base primitives | `ui/` | Radix/shadcn components; prefer reuse |
| App shell | `AppLayout/` | sidebar/header/page frame |
| Chat/RAG | `Playground/`, `Chats/`, `PublicChat/` | chat UI, streaming, public chat |
| Wiki | `PublicWiki/` | public wiki reader widgets |
| Memos | `Memos/` | upload/list/detail/modals |
| Manual submission | `MemoSubmission*`, `PublicMemoSubmission*` | review/public submission flows |
| Getting started | `GettingStarted/`, `Onboarding*` | setup flows |
| Auth/account | `SignupFlow.tsx`, `SignupForm/`, `VerifyEmailForm/`, `GoogleAuthButton/`, `CompleteProfileForm/`, `AuthPromo/` | login/signup/profile verification UI |
| Admin | `Admin/` | administrative screens |
| Evaluation | `Evaluate/` | datasets/experiments/results |
| Subscription | `Subscription/` | plan/usage/billing views |
| Organization | `Organization/` | membership/invite/settings |
| Utilities | `utils/` | component-local formatting helpers |

## CONVENTIONS

- Use `ui/` primitives for standard buttons, inputs, dialogs, tabs, switches, and tables.
- Feature folders own their forms, modals, empty states, and table helpers.
- Domain DTOs come from `@/lib/types`; component props get explicit TypeScript interfaces.
- Tailwind classes are merged with `cn()`; inline styles only for calculated dynamic positions/sizes.
- Long streaming/chat UI updates should flow through stores and editor helpers, not ad-hoc timers in components.

## ANTI-PATTERNS

- No raw `axios`/`fetch` imports in component files.
- Do not create duplicate primitive components when `ui/` already has one.
- Avoid feature components above ~300 lines; split into same-folder subcomponents.
- Do not pass shared state more than 2-3 levels; use store selectors.
