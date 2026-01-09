# FRONTEND COMPONENTS

**Generated:** 2026-01-10
**Domain:** Core UI (Score 15)

## OVERVIEW

React UI components divided into reusable shadcn/ui primitives and modular feature-specific components.

## WHERE TO LOOK

- **Base UI Primitives:** `ui/` - Reusable Radix-based components (Button, Input, Dialog, etc.)
- **Layout & Shell:** `AppLayout/` - Main application structure, sidebar, and page headers
- **RAG & Chat:** `Playground/` - Chat interface, RAG configuration, and retrieval visualization
- **Ingestion/Memos:** `Memos/` - Document management table, upload modals, and detailed views
- **Analytics/Eval:** `Evaluate/` - Dataset management and experiment tracking/results
- **Subscription:** `Subscription/` - Pricing cards, usage dashboards, and plan management
- **Organization:** `Organization/` - Team member management, invites, and settings
- **Common Utils:** `utils/` - Component-specific formatters (dates, strings)

## CONVENTIONS

- **Atomic UI:** Use `ui/` primitives for all basic elements; avoid custom HTML tags for standard UI
- **Feature Isolation:** Keep feature-specific logic (forms, modals, tables) inside their respective folders
- **State Selection:** `useState` for transient UI state (e.g., `isHovered`, `activeTab`); Zustand for anything else
- **API Guard:** All data fetching must go through `@/lib/api.ts`. No raw axios/fetch in components
- **Modals:** Each feature folder should manage its own modals (e.g., `Memos/CreateMemoModal.tsx`)
- **Prop Types:** Use TypeScript interfaces for all component props; prefer `@/lib/types` for domain models
- **Styling:** Strict Tailwind CSS. Follow `cn()` utility pattern from shadcn for class merging

## ANTI-PATTERNS

- **Prop Drilling:** Don't pass state down more than 2 levels; use Zustand or React Context if deeper
- **Direct Styles:** No CSS-in-JS or inline `style` tags unless calculating dynamic positions/sizes
- **Big Components:** Files >300 lines should be broken down into smaller sub-components in the same folder
- **Logic Overload:** Components should focus on rendering; move heavy data processing to `utils/` or stores
- **Reinventing UI:** Don't build a new button or dialog if one exists in `ui/`
- **Axios in Components:** Never import `axios` directly in a component file
