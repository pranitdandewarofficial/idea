# ADR-0001 — Vite + React SPA instead of Next.js

**Status:** accepted · **Date:** 2026-10 · **Deciders:** founder + build agent

## Context

The product is a local-first control plane for an autonomous AI company. It has ten areas,
a live event stream, and a canvas city that must animate at 60 fps while data arrives over
a WebSocket. It runs on one machine, for one user, with a FastAPI backend on
`127.0.0.1:8000`.

Next.js is the default choice for a React product, so it needed an explicit rejection.

## Decision

Build the frontend as a **Vite 6 + React 19 + TypeScript 5.7 single-page app** with
`react-router-dom` 7 for routing, Tailwind 4 (`@tailwindcss/vite`) for styling, zustand 5
for cross-cutting state, and vitest 3 + Testing Library for tests.

## Reasons

1. **There is nothing to server-render.** Every screen is post-authentication, per-user,
   live state. SSR would render a loading skeleton on the server and hydrate into a fetch
   anyway. SEO is irrelevant for `localhost`.
2. **The backend is the server.** Adding a Node server layer means two servers, two port
   allocations, two proxy hops, and a second place for the bearer token to leak. Vite's
   dev proxy forwards `/api` and `/ws` to FastAPI and disappears at build time.
3. **Browser-visible URLs must stay relative.** With an SPA the client only ever calls
   `/api/...`, so the same bundle works behind `localhost:5173`, `localhost:4173`, a
   sandbox preview host, or `docker compose` without a single hard-coded origin. A Next.js
   server component would need the backend URL at build/render time on the server.
4. **Fewer moving parts to install.** `npm install && npm run dev`. No `next.config.js`,
   no app-router conventions, no edge/node runtime split, no cache semantics to reason
   about for a tool that a founder installs once.
5. **Startup and rebuild latency.** Vite cold-starts in ~230 ms here and HMR is instant,
   which matters because the canvas and the live stream get touched constantly.

## Consequences

* No SSR/ISR, no file-based API routes, no server components. Accepted: none were needed.
* Deep links are handled client-side; a static host must fall back to `index.html`.
* The build is one JS bundle (485 kB, 141 kB gzip). If it grows, route-level
  `React.lazy` splitting is the next step; it is not needed at ten areas.
* `docker-compose.yml` runs the dev server for the UI. For a long-lived install, serve
  `frontend/dist/` from any static server that proxies `/api` and `/ws` to the backend.

## Alternatives considered

* **Next.js (app router)** — rejected for the reasons above; the extra server buys nothing
  here and costs a second trust boundary.
* **Remix / React Router v7 framework mode** — closer, but still ships a server we do not
  need; we use React Router purely as a client router.
* **SvelteKit / SolidStart** — fine technology, but the brief specifies React-grade
  ecosystem familiarity and the canvas work is framework-agnostic anyway.
* **No framework (plain canvas + fetch)** — tempting for the city alone, but ten data-dense
  screens with live updates would turn into hand-rolled state management.
