/**
 * The interactive city canvas: pan, zoom, hover, click, keyboard districts.
 * Rendering stops entirely while the tab is hidden.
 */
import { useCallback, useEffect, useRef } from "react";
import type { CityLayout } from "../lib/types";
import {
  approach, clampView, districtBuilding, fitView, focusRect, pick, screenToWorld, zoomAt,
  type View,
} from "./view";
import { drawCity, type AgentFrame } from "./draw";

export interface FocusRequest {
  key: string;
  rect: { x: number; y: number; w: number; h: number };
  scale?: number;
}

interface Props {
  layout: CityLayout;
  compact: boolean;
  reducedMotion: boolean;
  selectedId: string | null;
  focus: FocusRequest | null;
  onSelect: (selection: { kind: "agent" | "building"; id: string } | null) => void;
  onHover?: (id: string | null) => void;
  className?: string;
}

export function CityCanvas({
  layout, compact, reducedMotion, selectedId, focus, onSelect, onHover, className,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<View>({ x: 0, y: 0, scale: 1 });
  const targetRef = useRef<View>({ x: 0, y: 0, scale: 1 });
  const framesRef = useRef<Map<string, AgentFrame>>(new Map());
  const hoveredRef = useRef<string | null>(null);
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const compactRef = useRef(compact);
  compactRef.current = compact;
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const fit = useCallback(() => {
    const size = sizeRef.current;
    const next = fitView(layoutRef.current.world, size);
    viewRef.current = next;
    targetRef.current = next;
  }, []);

  // ---- sizing ----------------------------------------------------------- //
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      sizeRef.current = { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const first = viewRef.current.scale === 1 && viewRef.current.x === 0 && viewRef.current.y === 0;
      if (first) fit();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [fit]);

  // ---- focus requests --------------------------------------------------- //
  useEffect(() => {
    if (!focus) return;
    targetRef.current = focusRect(focus.rect, sizeRef.current, focus.scale ?? Math.max(viewRef.current.scale, 1.1));
  }, [focus]);

  // ---- render loop ------------------------------------------------------ //
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) return;
      const delta = Math.min(0.1, (now - last) / 1000);
      last = now;

      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d") ?? null;
      const current = layoutRef.current;
      if (!canvas || !ctx || !current) return;

      const view = viewRef.current;
      const target = targetRef.current;
      view.x = approach(view.x, target.x, delta, 220);
      view.y = approach(view.y, target.y, delta, 220);
      view.scale = approach(view.scale, target.scale, delta, 220);
      viewRef.current = clampView(view, current.world, sizeRef.current);
      targetRef.current = viewRef.current;

      const frames = framesRef.current;
      for (const agent of current.agents) {
        const previous = frames.get(agent.id);
        if (!previous) {
          frames.set(agent.id, { id: agent.id, x: agent.city_x, y: agent.city_y });
          continue;
        }
        if (reducedRef.current) {
          frames.set(agent.id, { id: agent.id, x: agent.city_x, y: agent.city_y });
          continue;
        }
        frames.set(agent.id, {
          id: agent.id,
          x: approach(previous.x, agent.city_x, delta),
          y: approach(previous.y, agent.city_y, delta),
        });
      }
      for (const id of Array.from(frames.keys())) {
        if (!current.agents.some((agent) => agent.id === id)) frames.delete(id);
      }

      drawCity(ctx, {
        layout: current,
        frames,
        view: viewRef.current,
        width: sizeRef.current.width,
        height: sizeRef.current.height,
        timeSeconds: now / 1000,
        compact: compactRef.current,
        reducedMotion: reducedRef.current,
        hoveredId: hoveredRef.current,
        selectedId: selectedRef.current,
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- input ------------------------------------------------------------ //
  const toWorld = useCallback((event: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return screenToWorld(viewRef.current, event.clientX - rect.left, event.clientY - rect.top);
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    (event.target as HTMLCanvasElement).setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, moved: false };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      drag.x = event.clientX;
      drag.y = event.clientY;
      viewRef.current = clampView({ ...viewRef.current, x: viewRef.current.x + dx, y: viewRef.current.y + dy },
                                  layoutRef.current.world, sizeRef.current);
      targetRef.current = viewRef.current;
      return;
    }
    const world = toWorld(event);
    if (!world) return;
    const hit = pick(layoutRef.current, world.x, world.y);
    const id = hit ? (hit.kind === "agent" ? hit.agent.id : hit.building.id) : null;
    if (id !== hoveredRef.current) {
      hoveredRef.current = id;
      onHover?.(id);
    }
    if (canvasRef.current) canvasRef.current.style.cursor = id ? "pointer" : "grab";
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.moved) return;
    const world = toWorld(event);
    if (!world) return;
    const hit = pick(layoutRef.current, world.x, world.y);
    onSelect(hit ? { kind: hit.kind, id: hit.kind === "agent" ? hit.agent.id : hit.building.id } : null);
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = zoomAt(viewRef.current, factor, event.clientX - rect.left, event.clientY - rect.top);
    viewRef.current = clampView(next, layoutRef.current.world, sizeRef.current);
    targetRef.current = viewRef.current;
  };

  // ---- keyboard --------------------------------------------------------- //
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.key === "Escape") {
        onSelect(null);
        fit();
        return;
      }
      if (/^[1-9]$/.test(event.key)) {
        const building = districtBuilding(layoutRef.current, event.key);
        if (building) {
          targetRef.current = focusRect(
            { x: building.x - 60, y: building.y - 60, w: building.w + 120, h: building.h + 120 },
            sizeRef.current,
            Math.max(viewRef.current.scale, 1.2),
          );
          onSelect({ kind: "building", id: building.id });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fit, onSelect]);

  return (
    <div ref={wrapRef} className={className ?? "relative h-full w-full"}>
      <canvas
        ref={canvasRef}
        className="block h-full w-full touch-none"
        style={{ cursor: "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          hoveredRef.current = null;
          onHover?.(null);
        }}
        onWheel={onWheel}
        aria-label="Live map of the AI company"
        role="img"
      />
    </div>
  );
}
