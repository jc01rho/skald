# FRONTEND STATE MANAGEMENT

**Generated:** 2026-04-29
**Domain:** Zustand State (Score 15)

## OVERVIEW

Domain-specific Zustand stores coordinate shared frontend state and API side effects.

## WHERE TO LOOK

| Store | File | State |
| --- | --- | --- |
| Auth | `authStore.ts` | user, login/logout, org membership |
| Chat | `chatStore.ts` | chat sessions, SSE, runtime `userContext` |
| Chat list | `chatsListStore.ts` | chat sidebar/list loading |
| Public chat | `publicChatStore.ts` | shared/public chat SSE state |
| Project | `projectStore.ts` | current project and project list |
| Memo | `memoStore.ts` | memo CRUD, upload, filters |
| Memo submission | `memoSubmissionStore.ts`, `memoSubmissionReviewStore.ts`, `publicMemoSubmissionStore.ts` | manual submission/review/public flows |
| LLM config | `llmConfigStore.ts` | selectable model/runtime config |
| Evaluation datasets | `evaluateDatasetsStore.ts` | dataset management |
| Experiments | `evaluateExperimentsStore.ts` | experiment tracking |
| Organization | `organizationStore.ts` | members/invites/settings |
| Subscription | `subscriptionStore.ts` | plans, usage, Stripe state |
| Upgrade prompt | `upgradePromptStore.ts` | global 402/limit prompt |
| Onboarding | `onboardingStore.ts` | setup checklist/progress |

## CONVENTIONS

- Store actions call `@/lib/api.ts`; components call store actions for shared data.
- Cross-store coordination uses `useOtherStore.getState().action()` inside actions.
- Async actions return `Promise<void>` or typed results; state updates use `set()`.
- Persist only intentional settings. `chatStore` keeps `userContext` runtime-only and cleans old persisted values via migration.
- Toast user-visible failures via `sonner` when the store owns the action.

## ANTI-PATTERNS

- Never use Zustand for purely local hover/open/active-tab state.
- Never make raw HTTP calls from stores; wrap through `api.ts`.
- Never persist secrets, API keys, or free-form `userContext`.
- Never mutate nested state in place; return new arrays/objects.
