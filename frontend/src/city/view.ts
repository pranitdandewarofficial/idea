/**
 * City view maths. Pure functions so they can be unit-tested without a canvas:
 * the backend owns the layout, this module owns the camera and hit-testing.
 */
import type { Building, CityAgent, CityLayout } from "../lib/types";

export interface View {
  x: number;
  y: number;
  scale: number;
}

export const MIN_SCALE = 0.4;
export const MAX_SCALE = 2.5;

export function clampScale(scale: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
}

/** Fit the whole world into a viewport of the given size, with padding. */
export function fitView(world: { width: number; height: number }, viewport: { width: number; height: number },
                        padding = 48): View {
  if (viewport.width <= 0 || viewport.height <= 0) return { x: 0, y: 0, scale: 1 };
  const scale = clampScale(
    Math.min((viewport.width - padding * 2) / world.width, (viewport.height - padding * 2) / world.height),
  );
  return {
    scale,
    x: (viewport.width - world.width * scale) / 2,
    y: (viewport.height - world.height * scale) / 2,
  };
}

/** Keep at least part of the world on screen so the user can never get lost. */
export function clampView(view: View, world: { width: number; height: number },
                          viewport: { width: number; height: number }): View {
  const margin = 120;
  const maxX = margin;
  const minX = viewport.width - world.width * view.scale - margin;
  const maxY = margin;
  const minY = viewport.height - world.height * view.scale - margin;
  return {
    scale: clampScale(view.scale),
    x: minX < maxX ? Math.max(minX, Math.min(maxX, view.x)) : (minX + maxX) / 2,
    y: minY < maxY ? Math.max(minY, Math.min(maxY, view.y)) : (minY + maxY) / 2,
  };
}

export function screenToWorld(view: View, screenX: number, screenY: number): { x: number; y: number } {
  return { x: (screenX - view.x) / view.scale, y: (screenY - view.y) / view.scale };
}

/** Zoom around a fixed screen point (the cursor stays over the same world pixel). */
export function zoomAt(view: View, factor: number, screenX: number, screenY: number): View {
  const scale = clampScale(view.scale * factor);
  const world = screenToWorld(view, screenX, screenY);
  return { scale, x: screenX - world.x * scale, y: screenY - world.y * scale };
}

/** Centre the camera on a rectangle, keeping the current scale. */
export function focusRect(rect: { x: number; y: number; w: number; h: number },
                          viewport: { width: number; height: number }, scale: number): View {
  const used = clampScale(scale);
  return {
    scale: used,
    x: viewport.width / 2 - (rect.x + rect.w / 2) * used,
    y: viewport.height / 2 - (rect.y + rect.h / 2) * used,
  };
}

export function buildingAt(layout: CityLayout, worldX: number, worldY: number): Building | null {
  for (let i = layout.buildings.length - 1; i >= 0; i -= 1) {
    const b = layout.buildings[i];
    if (worldX >= b.x && worldX <= b.x + b.w && worldY >= b.y && worldY <= b.y + b.h) return b;
  }
  return null;
}

export function agentAt(layout: CityLayout, worldX: number, worldY: number, radius = 16): CityAgent | null {
  let nearest: CityAgent | null = null;
  let best = radius * radius;
  for (const agent of layout.agents) {
    const dx = agent.city_x - worldX;
    const dy = agent.city_y - worldY;
    const distance = dx * dx + dy * dy;
    if (distance <= best) {
      best = distance;
      nearest = agent;
    }
  }
  return nearest;
}

export function pick(layout: CityLayout, worldX: number, worldY: number):
  { kind: "agent"; agent: CityAgent } | { kind: "building"; building: Building } | null {
  const agent = agentAt(layout, worldX, worldY);
  if (agent) return { kind: "agent", agent };
  const building = buildingAt(layout, worldX, worldY);
  if (building) return { kind: "building", building };
  return null;
}

/** Keyboard districts: 1..9 select the nth building in the backend's own order. */
export function districtBuilding(layout: CityLayout, key: string): Building | null {
  const index = Number(key) - 1;
  const order = layout.order ?? layout.buildings.map((b) => b.id);
  if (!Number.isFinite(index) || index < 0 || index >= order.length) return null;
  return layout.buildings.find((b) => b.id === order[index]) ?? null;
}

export interface MotionSample {
  x: number;
  y: number;
}

/**
 * Frame-rate independent easing towards a target. `t` is seconds since the last
 * frame; the factor is chosen so the avatar covers ~90% of the gap in 260 ms,
 * matching the motion duration in the design tokens.
 */
export function approach(current: number, target: number, deltaSeconds: number, durationMs = 260): number {
  if (!Number.isFinite(current)) return target;
  const k = 1 - Math.exp((-3 * Math.max(0, deltaSeconds) * 1000) / Math.max(durationMs, 1));
  const next = current + (target - current) * k;
  return Math.abs(target - next) < 0.01 ? target : next;
}

export function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}
