# ADR-0002 — Hand-written Canvas 2D city instead of PixiJS

**Status:** accepted · **Date:** 2026-10 · **Deciders:** founder + build agent

## Context

The city is the product's centre of gravity: eleven buildings, roads, twelve agents that
move between seats, live task markers, and status colouring that must reflect the database
rather than an animation. It has to feel premium and stay smooth on a laptop while a run is
streaming events.

The obvious choice for 2D in the browser is a renderer — PixiJS, or a game engine.

## Decision

Render the city with the **native Canvas 2D API**, in one module
(`frontend/src/city/draw.ts`, ~307 lines), driven by pure camera maths in
`frontend/src/city/view.ts` and a React wrapper in `CityCanvas.tsx`. No rendering
dependency at all.

## Reasons

1. **The scene is small and static-shaped.** ~12 buildings, ~12 agents, a handful of task
   markers, roads. Canvas 2D draws that in well under a millisecond of path work; a WebGL
   scene graph is solving a problem we do not have.
2. **Zero dependency, zero supply-chain surface.** A local-first product that runs tools on
   your machine should not pull a rendering engine into the bundle for one screen. The
   whole frontend bundle is 485 kB (141 kB gzip) including React, the router, icons and
   Tailwind.
3. **The camera maths is the interesting part, and it is ours.** Fit, clamp, zoom-at-cursor
   invariance, focus-rect, hit-testing, district keys, frame-rate-independent easing — all
   pure functions, all unit-tested (`city/view.test.ts`, 16 tests). A renderer would have
   hidden them behind its own scene API and made them harder to test.
4. **Testability without a GPU.** jsdom returns `null` from `getContext`, so the pure
   maths is tested directly and the render path is exercised for graceful degradation. A
   WebGL renderer cannot be tested at all in that environment.
5. **Art direction is easier to control.** The design language is flat, light, one accent
   colour, no glow and no gradients. That is a few `fillRect`/`stroke` calls; a game engine
   pushes you toward shaders, sprites and atlases.
6. **Honest performance controls.** Rendering stops entirely when `document.hidden`, and
   `compact_mode` (a real persisted setting, toggled with `C`) drops labels and animation
   for slow hardware. Both are trivial to implement when you own the draw loop.

## Consequences

* No sprite batching, no texture atlases, no shader effects. If the city ever grows to
  hundreds of moving entities, this decision should be revisited.
* We own every visual detail — roads, roofs, seats, hover rings, marker pulses. That is
  ~300 lines to maintain instead of a dependency to upgrade.
* High-DPI handling, pan/zoom inertia and hit-testing are manual. They are implemented and
  tested.
* The renderer must tolerate a missing 2D context (jsdom, exotic browsers); it does.

## Alternatives considered

* **PixiJS** — excellent, but a WebGL scene graph for twelve buildings, plus ~450 kB of
  dependency and an untestable render path.
* **SVG + React** — declarative and accessible, but per-frame React reconciliation for
  smooth agent motion is the wrong trade; we would end up bypassing React anyway.
* **Three.js / react-three-fiber** — a 3D city is a different product and a much larger
  art-direction problem; the brief asks for 2D.
* **Konva / Fabric** — object models we would fight, since our objects are database rows.
