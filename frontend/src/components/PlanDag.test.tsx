/** The DAG must reflect the real depends_on graph, in the real execution order. */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { Task } from "../lib/types";
import { PlanDag, dagLayers } from "./PlanDag";

function task(partial: Partial<Task> & { id: string; title: string }): Task {
  return {
    external_id: partial.id.toUpperCase(),
    plan_id: "plan-1",
    project_id: "project-1",
    description: "",
    agent_id: null,
    status: "pending",
    depends_on: [],
    outputs: [],
    done_criteria: [],
    verify_commands: [],
    priority: 3,
    effort: 1,
    order_index: 0,
    retries: 0,
    summary: null,
    error: null,
    files_changed: [],
    verification: { verified: null, checks: [] },
    tokens_used: 0,
    created_at: null,
    updated_at: null,
    ...partial,
  } as Task;
}

describe("dagLayers", () => {
  it("puts independent tasks in layer 1 and dependants behind them", () => {
    const tasks = [
      task({ id: "a", title: "Scaffold", order_index: 0 }),
      task({ id: "b", title: "API", depends_on: ["a"], order_index: 1 }),
      task({ id: "c", title: "UI", depends_on: ["a"], order_index: 2 }),
      task({ id: "d", title: "Integrate", depends_on: ["b", "c"], order_index: 3 }),
    ];
    const layers = dagLayers(tasks);
    expect(layers).toHaveLength(3);
    expect(layers[0].map((row) => row.id)).toEqual(["a"]);
    expect(layers[1].map((row) => row.id)).toEqual(["b", "c"]);
    expect(layers[2].map((row) => row.id)).toEqual(["d"]);
  });

  it("sorts a layer by order_index then external id", () => {
    const tasks = [
      task({ id: "z", title: "Z", external_id: "T-02", order_index: 1 }),
      task({ id: "y", title: "Y", external_id: "T-01", order_index: 1 }),
      task({ id: "x", title: "X", external_id: "T-03", order_index: 0 }),
    ];
    expect(dagLayers(tasks)[0].map((row) => row.id)).toEqual(["x", "y", "z"]);
  });

  it("ignores a dependency on a task that is not in the plan", () => {
    const layers = dagLayers([task({ id: "a", title: "A", depends_on: ["ghost"] })]);
    expect(layers).toHaveLength(1);
  });

  it("does not loop forever on a cyclic graph", () => {
    const layers = dagLayers([
      task({ id: "a", title: "A", depends_on: ["b"] }),
      task({ id: "b", title: "B", depends_on: ["a"] }),
    ]);
    expect(layers.flat()).toHaveLength(2);
  });

  it("handles an empty plan", () => {
    expect(dagLayers([])).toEqual([]);
  });
});

describe("<PlanDag />", () => {
  it("renders one card per task with its real status and owner", () => {
    const tasks = [
      task({ id: "a", title: "Scaffold the FastAPI app", agent_id: "dev", status: "completed",
             verification: { verified: true, checks: [{ command: "ls src/app.py", code: 0, passed: true }] } }),
      task({ id: "b", title: "Write the pytest suite", agent_id: "rhea", status: "failed",
             depends_on: ["a"], retries: 2, error: "assert 1 == 2" }),
    ];
    render(<PlanDag tasks={tasks} />);

    expect(screen.getByText("Scaffold the FastAPI app")).toBeTruthy();
    expect(screen.getByText("Write the pytest suite")).toBeTruthy();
    expect(screen.getByText("verified")).toBeTruthy();
    expect(screen.getByText("retries 2")).toBeTruthy();
    expect(screen.getAllByText("failed").length).toBeGreaterThan(0);
    expect(screen.getByText("2 tasks in 2 layers · left to right is the real execution order")).toBeTruthy();
  });

  it("draws one edge per real dependency", () => {
    const tasks = [
      task({ id: "a", title: "A" }),
      task({ id: "b", title: "B", depends_on: ["a"] }),
      task({ id: "c", title: "C", depends_on: ["a", "b"] }),
    ];
    const { container } = render(<PlanDag tasks={tasks} />);
    // jsdom reports zero-sized boxes, so edges collapse to a point; the count is
    // still the real dependency count.
    expect(container.querySelectorAll("svg path")).toHaveLength(3);
  });

  it("shows an honest empty state instead of a decorative graph", () => {
    render(<PlanDag tasks={[]} />);
    expect(screen.getByText("No tasks")).toBeTruthy();
    expect(screen.getByText("The plan has not been broken into tasks yet.")).toBeTruthy();
  });

  it("marks the selected card and reports clicks", () => {
    const tasks = [task({ id: "a", title: "Scaffold" }), task({ id: "b", title: "Test", depends_on: ["a"] })];
    const clicked: { current: Task | null } = { current: null };
    render(<PlanDag tasks={tasks} selectedId="b" onSelect={(row) => { clicked.current = row; }} />);
    const cards = screen.getAllByRole("button");
    const testCard = cards.find((card) => within(card).queryByText("Test"));
    expect(testCard?.className).toContain("border-accent");
    testCard?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicked.current?.id).toBe("b");
  });
});
