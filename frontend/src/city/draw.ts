/**
 * Canvas 2D renderer for the city.
 *
 * Everything drawn here comes from `GET /api/city`: building rectangles, road
 * segments, agent seats and task markers. The renderer adds no state of its own
 * beyond camera position and animation interpolation, so what you see is what
 * the backend really has.
 */
import type { CityAgent, CityLayout } from "../lib/types";
import { initials } from "../lib/format";
import { roundedRectPath } from "./view";

const CANVAS_BG = "#fbfbfd";
const GRID = "#f1f2f6";
const ROAD = "#e6e8ef";
const ROAD_EDGE = "#dcdfe8";
const INK = "#0b1020";
const INK_SOFT = "#3d4560";
const INK_FAINT = "#6b7390";
const ACCENT = "#5b6cff";
const POSITIVE = "#14804a";
const WARNING = "#9a6100";
const DANGER = "#b3261e";

export interface AgentFrame {
  id: string;
  x: number;
  y: number;
}

export interface DrawOptions {
  layout: CityLayout;
  frames: Map<string, AgentFrame>;
  view: { x: number; y: number; scale: number };
  width: number;
  height: number;
  timeSeconds: number;
  compact: boolean;
  reducedMotion: boolean;
  hoveredId: string | null;
  selectedId: string | null;
}

export function drawCity(ctx: CanvasRenderingContext2D, options: DrawOptions): void {
  const { layout, view, width, height } = options;
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = CANVAS_BG;
  ctx.fillRect(0, 0, width, height);

  ctx.translate(view.x, view.y);
  ctx.scale(view.scale, view.scale);

  drawGround(ctx, layout);
  drawRoads(ctx, layout);
  for (const building of layout.buildings) drawBuilding(ctx, building, layout, options);
  drawTaskMarkers(ctx, layout, options);
  for (const agent of layout.agents) drawAgent(ctx, agent, options);

  ctx.restore();
}

function drawGround(ctx: CanvasRenderingContext2D, layout: CityLayout) {
  const { width, height } = layout.world;
  ctx.save();
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  const step = 80;
  ctx.beginPath();
  for (let x = step; x < width; x += step) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = step; y < height; y += step) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  // central plaza: the hub every road connects to
  ctx.fillStyle = "#f4f5f8";
  ctx.strokeStyle = ROAD_EDGE;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(840, 550, 92, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = INK_FAINT;
  ctx.font = "500 12px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("FOUNDER'S PLAZA", 840, 546);
  ctx.font = "400 11px Inter, sans-serif";
  ctx.fillText("one orchestrator", 840, 562);
  ctx.restore();
}

function drawRoads(ctx: CanvasRenderingContext2D, layout: CityLayout) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = ROAD;
  ctx.lineWidth = 14;
  ctx.beginPath();
  for (const road of layout.roads) {
    ctx.moveTo(road.from[0], road.from[1]);
    ctx.lineTo(road.to[0], road.to[1]);
  }
  ctx.stroke();

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([8, 10]);
  ctx.beginPath();
  for (const road of layout.roads) {
    ctx.moveTo(road.from[0], road.from[1]);
    ctx.lineTo(road.to[0], road.to[1]);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawBuilding(
  ctx: CanvasRenderingContext2D,
  building: CityLayout["buildings"][number],
  layout: CityLayout,
  options: DrawOptions,
) {
  const state = layout.buildings_state[building.id] ?? { active: 0, blocked: 0, agents: [] };
  const { x, y, w, h } = building;
  const isActive = state.active > 0;
  const isBlocked = state.blocked > 0;
  const hovered = options.hoveredId === building.id;
  const selected = options.selectedId === building.id;

  ctx.save();
  // shadow
  ctx.fillStyle = "rgba(11,16,32,0.05)";
  roundedRectPath(ctx, x + 3, y + 6, w, h, 12);
  ctx.fill();

  // body
  ctx.fillStyle = building.color;
  roundedRectPath(ctx, x, y, w, h, 12);
  ctx.fill();
  ctx.lineWidth = selected ? 2.5 : hovered ? 2 : 1;
  ctx.strokeStyle = selected || hovered ? ACCENT : "#dcdfe8";
  ctx.stroke();

  // roof band carries the department accent
  ctx.save();
  roundedRectPath(ctx, x, y, w, h, 12);
  ctx.clip();
  ctx.fillStyle = building.accent;
  ctx.globalAlpha = isActive ? 0.9 : 0.35;
  ctx.fillRect(x, y, w, 10);
  ctx.globalAlpha = 1;
  ctx.restore();

  // label
  ctx.textAlign = "center";
  ctx.fillStyle = INK;
  ctx.font = "600 14px Inter, sans-serif";
  ctx.fillText(building.name, x + w / 2, y + 38);

  if (!options.compact) {
    ctx.fillStyle = INK_FAINT;
    ctx.font = "400 11px Inter, sans-serif";
    const detail = wrap(ctx, building.detail || building.department, w - 28);
    detail.slice(0, 2).forEach((line, index) => {
      ctx.fillText(line, x + w / 2, y + 58 + index * 14);
    });
  }

  // occupancy lights: one per agent seated here, lit while really working
  const seats = state.agents.length;
  if (seats > 0) {
    const dotR = 4;
    const gap = 14;
    const startX = x + w / 2 - ((seats - 1) * gap) / 2;
    for (let i = 0; i < seats; i += 1) {
      ctx.beginPath();
      ctx.arc(startX + i * gap, y + h - 20, dotR, 0, Math.PI * 2);
      ctx.fillStyle = isBlocked ? WARNING : isActive ? ACCENT : "#c9cddb";
      ctx.fill();
    }
  }

  // status chip
  if (isBlocked) {
    chip(ctx, x + w / 2, y + h - 44, "BLOCKED", WARNING, "#fdf3e0");
  } else if (isActive) {
    chip(ctx, x + w / 2, y + h - 44, `${state.active} WORKING`, ACCENT, "#eef0ff");
  }
  ctx.restore();
}

function chip(ctx: CanvasRenderingContext2D, cx: number, cy: number, text: string, fg: string, bg: string) {
  ctx.save();
  ctx.font = "600 10px Inter, sans-serif";
  const w = ctx.measureText(text).width + 14;
  ctx.fillStyle = bg;
  roundedRectPath(ctx, cx - w / 2, cy - 9, w, 18, 9);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = "center";
  ctx.fillText(text, cx, cy + 3.5);
  ctx.restore();
}

function drawTaskMarkers(ctx: CanvasRenderingContext2D, layout: CityLayout, options: DrawOptions) {
  ctx.save();
  ctx.font = "600 10px 'JetBrains Mono', monospace";
  ctx.textAlign = "center";
  for (const marker of layout.task_markers) {
    const pulse = options.reducedMotion ? 1 : 0.72 + 0.28 * Math.sin(options.timeSeconds * 3 + marker.x / 40);
    ctx.globalAlpha = pulse;
    const tone = marker.status === "blocked" || marker.status === "failed"
      ? DANGER
      : marker.status === "repairing" || marker.status === "timeout"
        ? WARNING
        : ACCENT;
    const label = marker.external_id || marker.task_id.slice(0, 4);
    const w = ctx.measureText(label).width + 12;
    ctx.fillStyle = tone;
    roundedRectPath(ctx, marker.x - w / 2, marker.y - 9, w, 18, 9);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, marker.x, marker.y + 3.5);
    ctx.globalAlpha = 1;
    if (marker.retries > 0 && !options.compact) {
      ctx.fillStyle = INK_FAINT;
      ctx.font = "400 10px Inter, sans-serif";
      ctx.fillText(`retry ${marker.retries}`, marker.x, marker.y - 14);
      ctx.font = "600 10px 'JetBrains Mono', monospace";
    }
  }
  ctx.restore();
}

function drawAgent(ctx: CanvasRenderingContext2D, agent: CityAgent, options: DrawOptions) {
  const frame = options.frames.get(agent.id);
  const x = frame?.x ?? agent.city_x;
  const y = frame?.y ?? agent.city_y;
  const selected = options.selectedId === agent.id;
  const hovered = options.hoveredId === agent.id;
  const working = agent.status === "working" || agent.status === "collaborating";
  const blocked = agent.status === "blocked" || agent.status === "waiting";

  ctx.save();
  if (working && !options.reducedMotion) {
    const ring = 16 + 3 * Math.sin(options.timeSeconds * 4 + agent.city_x / 60);
    ctx.beginPath();
    ctx.arc(x, y, ring, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(91,108,255,0.35)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(x, y, 13, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = selected || hovered ? 2.5 : 1.5;
  ctx.strokeStyle = blocked ? WARNING : working ? ACCENT : "#c9cddb";
  ctx.stroke();

  ctx.fillStyle = blocked ? WARNING : working ? ACCENT : INK_SOFT;
  ctx.font = "600 10px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(initials(agent.name), x, y + 3.5);

  if (!options.compact || selected || hovered) {
    ctx.fillStyle = INK_SOFT;
    ctx.font = "500 11px Inter, sans-serif";
    ctx.fillText(agent.name, x, y + 28);
    if (!agent.is_decision_agent) {
      ctx.fillStyle = INK_FAINT;
      ctx.font = "400 10px Inter, sans-serif";
      ctx.fillText(agent.role, x, y + 41);
    }
  }
  if (agent.is_decision_agent) {
    ctx.fillStyle = "#7950f2";
    ctx.font = "600 9px Inter, sans-serif";
    ctx.fillText("SYSTEM 1", x, y - 20);
  }
  ctx.restore();
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export const CITY_COLORS = { POSITIVE, WARNING, DANGER, ACCENT, INK, INK_SOFT, INK_FAINT };
