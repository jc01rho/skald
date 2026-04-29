# FRONTEND PAGES

**Generated:** 2026-04-29
**Domain:** Route Entry Points (Score 12)

## OVERVIEW

Pages are thin route-level composers. Business logic belongs in stores, feature components, or backend APIs.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Route table | `../routes.tsx` | source of private/public/cloud route mapping |
| Public wiki graph | `PublicWikiGraphPage.tsx` | built-in SVG graph/text mode reader |
| Chat/playground | `PlaygroundPage.tsx`, chat-related pages | compose stores + components |
| Memo screens | memo pages | delegate CRUD/upload to `Memos/` components and stores |
| Auth/onboarding | auth/profile/setup pages | compose auth stores and form components |

## CONVENTIONS

- Keep pages mostly declarative: load store state, render layout, wire feature components.
- Route access rules live in `routes.tsx`; do not duplicate auth gates inside every page.
- Public routes must preserve same-origin API behavior unless `VITE_API_HOST` is configured.
- Large page-only helpers should move into `components/<Feature>/` or `lib/`.

## ANTI-PATTERNS

- Do not place direct `api` calls in pages when a domain store exists.
- Do not add route paths outside `routes.tsx`.
- Do not add graph dependencies for public wiki without explicit need; current graph rendering is built-in SVG.
