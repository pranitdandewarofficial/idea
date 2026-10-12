/**
 * The plan DAG. Layers are computed from the real `depends_on` graph returned by
 * the backend and edges are drawn between the measured card positions - no
 * decorative graph, every node is an actual task row.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { Panel, Badge, EmptyState } from "./ui";
import { StatusDot } from "./TaskDetail";
import { initials, toneFor } from "../lib/format";
import type { Task } from "../lib/types";

interface Edge {
  key: string;
  d: string;
  active: boolean;
}

export function dagLayers(tasks: Task[]): Task[][] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const depthCache = new Map<string, number>();
  const depthOf = (task: Task, seen: Set<string> = new Set()): number => {
    if (depthCache.has(task.id)) return depthCache.get(task.id)!;
    if (seen.has(task.id)) return 0;
    seen.add(task.id);
    const deps = task.depends_on
      .map((id) => byId.get(id))
      .filter((value): value is Task => Boolean(value));
    const depth = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => depthOf(dep, seen)));
    depthCache.set(task.id, depth);
    return depth;
  };
  const layers: Task[][] = [];
  for (const task of tasks) {
    const depth = depthOf(task);
    (layers[depth] ??= []).push(task);
  }
  return layers.map((layer) =>
    [...layer].sort((a, b) => a.order_index - b.order_index || a.external_id.localeCompare(b.external_id)),
  );
}

export function PlanDag({
  tasks, selectedId, onSelect, onRetry, busy,
}: {
  tasks: Task[];
  selectedId?: string | null;
  onSelect?: (task: Task) => void;
  onRetry?: (taskId: string) => void;
  busy?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [edges, setEdges] = useState<Edge[]>([]);
  const layers = useMemo(() => dagLayers(tasks), [tasks]);
  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  useLayoutEffect(() => {
    const measure = () => {
      const container = containerRef.current;
      if (!container) return;
      const box = container.getBoundingClientRect();
      const anchor = (id: string) => {
        const node = cardRefs.current.get(id);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {
          left: rect.left - box.left + container.scrollLeft,
          right: rect.right - box.left + container.scrollLeft,
          midY: rect.top - box.top + container.scrollTop + rect.height / 2,
        };
      };
      const next: Edge[] = [];
      for (const task of tasks) {
        for (const dep of task.depends_on) {
          if (!byId.has(dep)) continue;
          const from = anchor(dep);
          const to = anchor(task.id);
          if (!from || !to) continue;
          const dx = Math.max(24, (to.left - from.right) / 2);
          next.push({
            key: `${dep}->${task.id}`,
            d: `M ${from.right} ${from.midY} C ${from.right + dx} ${from.midY}, ${to.left - dx} ${to.midY}, ${to.left} ${to.midY}`,
            active: byId.get(dep)?.status === "completed",
          });
        }
      }
      setEdges(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (containerRef.current) observer.observe(containerRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [tasks, byId]);

  return (
    <Panel
      title="Dependency graph"
      subtitle={`${tasks.length} tasks in ${layers.length} layers · left to right is the real execution order`}
      actions={
        <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
          <StatusDot status="completed" /> done
          <StatusDot status="running" /> running
          <StatusDot status="failed" /> failed
        </div>
      }
      bodyClassName="p-0"
    >
      {tasks.length === 0 ? (
        <div className="p-4">
          <EmptyState title="No tasks" body="The plan has not been broken into tasks yet." />
        </div>
      ) : (
        <div ref={containerRef} className="relative overflow-x-auto scroll-thin">
          <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
            {edges.map((edge) => (
              <path key={edge.key} d={edge.d} fill="none"
                    stroke={edge.active ? "#5b6cff" : "#dcdfe8"}
                    strokeWidth={edge.active ? 1.6 : 1.2}
                    strokeDasharray={edge.active ? undefined : "4 4"} />
            ))}
          </svg>
          <div className="relative flex min-w-max gap-8 p-4">
            {layers.map((layer, index) => (
              <div key={index} className="flex w-[228px] shrink-0 flex-col gap-2">
                <p className="label px-0.5">layer {index + 1}</p>
                {layer.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    ref={(node) => {
                      if (node) cardRefs.current.set(task.id, node);
                      else cardRefs.current.delete(task.id);
                    }}
                    onClick={() => onSelect?.(task)}
                    className={clsx(
                      "panel-flat relative p-2.5 text-left transition-shadow duration-150 hover:shadow-panel",
                      selectedId === task.id && "border-accent ring-1 ring-accent",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <StatusDot status={task.status} />
                      <span className="numeric text-[11px] text-ink-faint">{task.external_id}</span>
                      <Badge tone={toneFor("task", task.status)} className="ml-auto">{task.status}</Badge>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[13px] font-medium">{task.title}</p>
                    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-faint">
                      <span className="flex h-4 w-4 items-center justify-center rounded-full border border-line text-[8px] font-semibold">
                        {initials(task.agent_id ?? "?")}
                      </span>
                      <span className="truncate">{task.agent_id ?? "unassigned"}</span>
                      {task.verification?.verified === true && <Badge tone="positive">verified</Badge>}
                      {task.verification?.verified === false && <Badge tone="danger">failed checks</Badge>}
                    </div>
                    {task.retries > 0 && (
                      <p className="numeric mt-1 text-[11px] text-warning">retries {task.retries}</p>
                    )}
                    {onRetry && task.status !== "running" && (
                      <span
                        role="button"
                        tabIndex={0}
                        className="absolute right-2 top-2 hidden text-[11px] text-accent group-hover:inline"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (busy?.startsWith("retry")) return;
                          onRetry(task.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.stopPropagation();
                            onRetry(task.id);
                          }
                        }}
                      >
                        retry
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
