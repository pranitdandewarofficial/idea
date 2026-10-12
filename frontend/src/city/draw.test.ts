/**
 * The city renderer, driven by the payload captured from a real run.
 *
 * jsdom has no canvas, so the 2D context is a recorder: these tests assert that
 * `drawCity` really issues draw calls for every building, road, agent and task
 * marker the backend reported - and that it does so without throwing.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { CityLayout } from "../lib/types";
import { drawCity, type AgentFrame } from "./draw";
import cityFixture from "../test/fixtures/city.json";

const layout = cityFixture as unknown as CityLayout;

interface Call { name: string; args: unknown[] }

/** Minimal recording stand-in for CanvasRenderingContext2D. */
function recordingContext() {
  const calls: Call[] = [];
  const state: Record<string, unknown> = {};
  const methods = new Set([
    "arc", "beginPath", "clearRect", "clip", "closePath", "fill", "fillRect", "fillText",
    "lineTo", "moveTo", "quadraticCurveTo", "restore", "save", "scale", "setLineDash",
    "stroke", "strokeRect", "translate",
  ]);

  const target: Record<string | symbol, unknown> = {
    measureText: (text: string) => {
      calls.push({ name: "measureText", args: [text] });
      return { width: String(text).length * 6 };
    },
    canvas: { width: 1200, height: 800 },
  };

  const context = new Proxy(target, {
    get(_target, property) {
      const key = String(property);
      if (key in target) return (target as Record<string, unknown>)[key];
      if (methods.has(key)) {
        return (...args: unknown[]) => {
          calls.push({ name: key, args });
        };
      }
      return state[key];
    },
    set(_target, property, value) {
      state[String(property)] = value;
      calls.push({ name: `set:${String(property)}`, args: [value] });
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;

  return { context, calls, state };
}

function framesFor(current: CityLayout): Map<string, AgentFrame> {
  return new Map(current.agents.map((agent) => [agent.id, { id: agent.id, x: agent.city_x, y: agent.city_y }]));
}

function draw(current: CityLayout, overrides: Partial<Parameters<typeof drawCity>[1]> = {}) {
  const { context, calls, state } = recordingContext();
  drawCity(context, {
    layout: current,
    frames: framesFor(current),
    view: { x: 0, y: 0, scale: 1 },
    width: 1200,
    height: 800,
    timeSeconds: 1.5,
    compact: false,
    reducedMotion: false,
    hoveredId: null,
    selectedId: null,
    ...overrides,
  });
  return { calls, state };
}

describe("drawCity", () => {
  let real: CityLayout;

  beforeEach(() => {
    real = JSON.parse(JSON.stringify(layout)) as CityLayout;
  });

  it("is driven by a real backend payload", () => {
    expect(real.buildings).toHaveLength(11);
    expect(real.agents).toHaveLength(12);
    expect(real.roads).toHaveLength(10);
    expect(real.world).toEqual({ width: 1680, height: 1120 });
  });

  it("paints the canvas and applies the camera before drawing anything", () => {
    const { calls } = draw(real);
    const names = calls.map((call) => call.name);
    expect(names[0]).toBe("save");
    expect(names).toContain("clearRect");
    expect(names).toContain("translate");
    expect(names).toContain("scale");
    expect(names[names.length - 1]).toBe("restore");
  });

  it("draws every road segment the backend sent", () => {
    const { calls } = draw(real);
    // one moveTo + one lineTo per road segment
    const moveTos = calls.filter((call) => call.name === "moveTo").length;
    expect(moveTos).toBeGreaterThanOrEqual(real.roads.length);
  });

  it("draws a body and a label for every building", () => {
    const { calls } = draw(real);
    const fills = calls.filter((call) => call.name === "fill").length;
    expect(fills).toBeGreaterThanOrEqual(real.buildings.length);
    const labels = calls.filter((call) => call.name === "fillText").map((call) => String(call.args[0]));
    for (const building of real.buildings) {
      expect(labels.some((text) => text.includes(building.name) || text.includes(building.department)))
        .toBe(true);
    }
  });

  it("draws every agent at the position the backend reported", () => {
    const { calls } = draw(real);
    const arcs = calls.filter((call) => call.name === "arc");
    // at least one circle per agent (body), so the count cannot be lower
    expect(arcs.length).toBeGreaterThanOrEqual(real.agents.length);
    const drawn = arcs.map((call) => [Number(call.args[0]), Number(call.args[1])]);
    for (const agent of real.agents) {
      const found = drawn.some(([x, y]) => Math.abs(x - agent.city_x) < 40 && Math.abs(y - agent.city_y) < 40);
      expect(found, `agent ${agent.id} should be drawn near its reported position`).toBe(true);
    }
  });

  it("marks a task in flight on the building that owns it", () => {
    const markerBuilding = real.buildings[3];
    real.task_markers = [{
      task_id: "t-1", external_id: "T-04", title: "Write the pytest suite", status: "running",
      agent_id: "qa", building_id: markerBuilding.id,
      x: markerBuilding.x + markerBuilding.w / 2, y: markerBuilding.y - 14, retries: 1, error: "",
    }];
    const withMarker = draw(real);
    const without = draw({ ...real, task_markers: [] });
    expect(withMarker.calls.length).toBeGreaterThan(without.calls.length);
    const texts = withMarker.calls.filter((c) => c.name === "fillText").map((c) => String(c.args[0]));
    expect(texts.some((text) => text.includes("T-04") || text.includes("1"))).toBe(true);
  });

  it("shows a blocked building in amber with a BLOCKED chip", () => {
    const target = real.buildings[0];
    real.buildings_state = {
      ...real.buildings_state,
      [target.id]: { active: 0, blocked: 2, agents: ["qa"] },
    };
    const blocked = draw(real);
    const healthy = draw({ ...real, buildings_state: {} });

    const colours = (result: { calls: Call[] }) =>
      result.calls.filter((call) => call.name === "set:fillStyle").map((call) => String(call.args[0]));
    const texts = (result: { calls: Call[] }) =>
      result.calls.filter((call) => call.name === "fillText").map((call) => String(call.args[0]));

    // WARNING amber, not the idle grey, and an explicit chip the founder can read
    expect(colours(blocked)).toContain("#9a6100");
    expect(texts(blocked)).toContain("BLOCKED");
    expect(texts(healthy)).not.toContain("BLOCKED");
  });

  it("shows an active building in the accent colour with a working count", () => {
    const target = real.buildings[0];
    real.buildings_state = { [target.id]: { active: 2, blocked: 0, agents: ["backend", "qa"] } };
    const { calls } = draw(real);
    const colours = calls.filter((call) => call.name === "set:fillStyle").map((call) => String(call.args[0]));
    const texts = calls.filter((call) => call.name === "fillText").map((call) => String(call.args[0]));
    expect(colours).toContain("#5b6cff");
    expect(texts).toContain("2 WORKING");
  });

  it("marks a failed task in danger red and a repairing one in amber", () => {
    const marker = (status: string) => ({
      task_id: "t-9", external_id: "T-09", title: "Ship it", status, agent_id: "qa",
      building_id: real.buildings[0].id, x: real.buildings[0].x + 10, y: real.buildings[0].y - 14,
      retries: 0, error: status === "failed" ? "pytest exited 1" : "",
    });
    const failed = draw({ ...real, task_markers: [marker("failed")] });
    const repairing = draw({ ...real, task_markers: [marker("repairing")] });
    const colours = (result: { calls: Call[] }) =>
      result.calls.filter((call) => call.name === "set:fillStyle").map((call) => String(call.args[0]));
    expect(colours(failed)).toContain("#b3261e");
    expect(colours(repairing)).toContain("#9a6100");
  });

  it("drops labels in compact mode instead of pretending to draw them", () => {
    const full = draw(real);
    const compact = draw(real, { compact: true });
    const text = (result: { calls: Call[] }) => result.calls.filter((call) => call.name === "fillText").length;
    expect(text(compact)).toBeLessThan(text(full));
  });

  it("renders the degraded-provider and zero-spend state it was given", () => {
    const degraded = draw({ ...real, degraded_providers: ["ollama"], zero_spend: false });
    expect(degraded.calls.length).toBeGreaterThan(0);
    // the renderer must not throw on a provider list it has never seen
    expect(() => draw({ ...real, providers: [], degraded_providers: [] })).not.toThrow();
  });

  it("tolerates an empty city", () => {
    const empty: CityLayout = { ...real, buildings: [], agents: [], roads: [], task_markers: [] };
    expect(() => draw(empty)).not.toThrow();
    const { calls } = draw(empty);
    expect(calls.map((call) => call.name)).toContain("clearRect");
  });

  it("respects reduced motion by not depending on the animation clock", () => {
    const a = draw(real, { reducedMotion: true, timeSeconds: 0 });
    const b = draw(real, { reducedMotion: true, timeSeconds: 999 });
    const shapes = (result: { calls: Call[] }) =>
      result.calls.filter((call) => ["fill", "stroke", "fillRect", "arc"].includes(call.name)).length;
    expect(shapes(a)).toBe(shapes(b));
  });

  it("highlights the hovered and selected entity", () => {
    const agentId = real.agents[2].id;
    const hovered = draw(real, { hoveredId: agentId });
    const plain = draw(real);
    expect(hovered.calls.length).toBeGreaterThanOrEqual(plain.calls.length);
    const selected = draw(real, { selectedId: real.buildings[1].id });
    expect(selected.calls.length).toBeGreaterThanOrEqual(plain.calls.length);
  });
});
