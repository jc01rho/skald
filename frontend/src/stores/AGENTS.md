# FRONTEND STATE MANAGEMENT

**Generated:** 2026-01-12
**Domain:** State Management (Score 15)

## OVERVIEW

Zustand stores for frontend state management, organized by domain.

## WHERE TO LOOK

| Store        | File                        | State                    |
| ------------ | --------------------------- | ------------------------ |
| Auth         | authStore.ts                | User, login/logout, org  |
| Chat         | chatStore.ts                | Chat sessions, streaming |
| Project      | projectStore.ts             | Current project, list    |
| Memo         | memoStore.ts                | Memo CRUD, filters       |
| Evaluation   | evaluateDatasetsStore.ts    | Dataset management       |
| Experiments  | evaluateExperimentsStore.ts | A/B testing              |
| Organization | organizationStore.ts        | Org management           |
| Subscription | subscriptionStore.ts        | Billing/Stripe           |
| Public Chat  | publicChatStore.ts          | Shared chats             |

## CONVENTIONS

**Store Pattern**

```typescript
import { create } from 'zustand'

interface State {
    state: Type
    action: () => Promise<void>
}
export const useStore = create<State>((set) => ({
    state: initial,
    action: async () => { ... }
}))
```

**Actions**

- Always call `api.ts` (NEVER direct axios)
- Use `set()` to update state
- Async actions return Promise<void>

**Cross-Store Dependencies**

```typescript
import { useOtherStore } from './otherStore'
await useOtherStore.getState().action()
```

**First Load Pattern**

```typescript
firstLoad: boolean // Track initial state
```

**Notifications**

- Toast via `sonner`: `toast.error('Message')`

**Persistence**

- Some state via `frontend/src/lib/localStorage.ts`

## ANTI-PATTERNS

- NEVER use `useState` for shared state - use Zustand stores
- NEVER put business logic in stores - keep them minimal
- NEVER access store state directly from other stores - use selectors
- NEVER make API calls directly in components (use store actions)
