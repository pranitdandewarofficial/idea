/** Pure camera and hit-testing maths behind the city canvas. */
import { describe, expect, it } from "vitest";
import type { Building, CityAgent, CityLayout } from "../lib/types";
import {
  MAX_SCALE, MIN_SCALE, approach, buildingAt, clampScale, clampView, districtBuilding, fitView,
  focusRect, pick, screenToWorld, zoomAt,
} from "./view";

const WORLD = { width: 1680, height: 1120 };
const VIEWPORT = { width: 1200, height: 800 };

function building(id: string, x: number, y: number, w = 120, h = 90): Building {
  return {
    id, name: id, department: id, x, y, w, h, color: "#fff", accent: "#000",
    icon: "office", detail: "", seats: [],
  };
}

function agent(id: string, x: number, y: number): CityAgent {
  return {
    id, name: id, role: id, department: "d", status: "idle", building_id: "b1",
    home_x: x, home_y: y, city_x: x, city_y: y, seat: 0, load: 0,
    is_decision_agent: false, current_task: null,
  };
}

function layout(): CityLayout {
  return {
    world: WORLD,
    buildings: [building("hq", 100, 100), building("lab", 400, 300)],
    roads: [],
    agents: [agent("dev", 160, 145), agent("rhea", 900, 900)],
    order: ["hq", "lab"],
    buildings_state: {},
    task_markers: [],
    active_plans: [],
    pending_approvals: 0,
    providers: [],
    degraded_providers: [],
    zero_spend: true,
    compact_mode: false,
  };
}

describe("clampScale", () => {
  it("keeps the scale inside the documented zoom range", () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(1.2)).toBe(1.2);
  });
});

describe("fitView", () => {
  it("fits the whole world and centres it", () => {
    const view = fitView(WORLD, VIEWPORT);
    expect(view.scale).toBeCloseTo(Math.min((1200 - 96) / 1680, (800 - 96) / 1120), 5);
    // the world must be fully inside the viewport
    expect(view.x).toBeGreaterThan(0);
    expect(view.y).toBeGreaterThan(0);
    expect(view.x + WORLD.width * view.scale).toBeLessThanOrEqual(VIEWPORT.width);
    expect(view.y + WORLD.height * view.scale).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it("never divides by a zero-sized viewport", () => {
    expect(fitView(WORLD, { width: 0, height: 0 })).toEqual({ x: 0, y: 0, scale: 1 });
  });
});

describe("clampView", () => {
  it("refuses to let the camera drift off into empty space", () => {
    const view = clampView({ x: 99999, y: -99999, scale: 1 }, WORLD, VIEWPORT);
    expect(view.x).toBeLessThanOrEqual(120);
    expect(view.y).toBeGreaterThanOrEqual(VIEWPORT.height - WORLD.height - 120);
  });

  it("centres the world when it is smaller than the viewport", () => {
    const small = { width: 100, height: 100 };
    const view = clampView({ x: 5000, y: 5000, scale: 0.4 }, small, VIEWPORT);
    // the world is 40x40 on screen, so centring means (viewport - world) / 2
    expect(view.x).toBeCloseTo((VIEWPORT.width - small.width * 0.4) / 2, 6);
    expect(view.y).toBeCloseTo((VIEWPORT.height - small.height * 0.4) / 2, 6);
  });
});

describe("screenToWorld / zoomAt", () => {
  it("round-trips a screen point through the camera", () => {
    const view = { x: 40, y: -20, scale: 1.5 };
    const world = screenToWorld(view, 340, 430);
    expect(world.x).toBeCloseTo((340 - 40) / 1.5, 6);
    expect(view.x + world.x * view.scale).toBeCloseTo(340, 6);
    expect(view.y + world.y * view.scale).toBeCloseTo(430, 6);
  });

  it("keeps the cursor over the same world pixel while zooming", () => {
    const view = fitView(WORLD, VIEWPORT);
    const before = screenToWorld(view, 600, 400);
    const zoomed = zoomAt(view, 1.4, 600, 400);
    const after = screenToWorld(zoomed, 600, 400);
    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.y).toBeCloseTo(before.y, 4);
    expect(zoomed.scale).toBeCloseTo(view.scale * 1.4, 6);
  });

  it("clamps instead of zooming past the limits", () => {
    const view = { x: 0, y: 0, scale: MAX_SCALE };
    expect(zoomAt(view, 10, 100, 100).scale).toBe(MAX_SCALE);
    expect(zoomAt({ x: 0, y: 0, scale: MIN_SCALE }, 0.01, 100, 100).scale).toBe(MIN_SCALE);
  });
});

describe("focusRect", () => {
  it("centres a building in the viewport at the requested scale", () => {
    const view = focusRect({ x: 400, y: 300, w: 120, h: 90 }, VIEWPORT, 1.6);
    expect(view.scale).toBe(1.6);
    const centre = { x: view.x + (400 + 60) * view.scale, y: view.y + (300 + 45) * view.scale };
    expect(centre.x).toBeCloseTo(VIEWPORT.width / 2, 6);
    expect(centre.y).toBeCloseTo(VIEWPORT.height / 2, 6);
  });
});

describe("hit testing", () => {
  it("finds the building under a world point", () => {
    expect(buildingAt(layout(), 150, 150)?.id).toBe("hq");
    expect(buildingAt(layout(), 5000, 5000)).toBeNull();
  });

  it("prefers the nearest agent inside the pick radius", () => {
    expect(pick(layout(), 165, 150)).toMatchObject({ kind: "agent", agent: { id: "dev" } });
    expect(pick(layout(), 110, 110)).toMatchObject({ kind: "building", building: { id: "hq" } });
    expect(pick(layout(), 5000, 5000)).toBeNull();
  });

  it("maps number keys onto the backend's own building order", () => {
    expect(districtBuilding(layout(), "1")?.id).toBe("hq");
    expect(districtBuilding(layout(), "2")?.id).toBe("lab");
    expect(districtBuilding(layout(), "9")).toBeNull();
    expect(districtBuilding(layout(), "x")).toBeNull();
  });

  it("falls back to the buildings array when the backend sends no order", () => {
    const withoutOrder = { ...layout(), order: undefined };
    expect(districtBuilding(withoutOrder, "2")?.id).toBe("lab");
  });
});

describe("approach", () => {
  it("moves towards the target and snaps when it is close enough", () => {
    const first = approach(0, 100, 1 / 60);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(100);
    let value = 0;
    for (let i = 0; i < 240; i += 1) value = approach(value, 100, 1 / 60);
    expect(value).toBe(100);
  });

  it("is frame-rate independent over the same wall-clock time", () => {
    let fast = 0;
    for (let i = 0; i < 16; i += 1) fast = approach(fast, 100, 1 / 60);
    let slow = 0;
    for (let i = 0; i < 4; i += 1) slow = approach(slow, 100, 4 / 60);
    expect(Math.abs(fast - slow)).toBeLessThan(2);
  });

  it("recovers from a non-finite current value", () => {
    expect(approach(Number.NaN, 42, 1 / 60)).toBe(42);
  });
});
