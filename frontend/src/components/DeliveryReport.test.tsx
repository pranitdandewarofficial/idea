/**
 * Rendered against a delivery report captured from a real end-to-end run
 * (backend/tests/test_06_e2e_run.py, offline mock provider). The point of these
 * assertions is the honesty rule: a mocked run must never read as a delivery.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { DeliveryReport } from "../lib/types";
import { DeliveryReportView } from "./DeliveryReport";
import captured from "../test/fixtures/delivery-report.json";

const report = captured as unknown as DeliveryReport;

describe("fixture provenance", () => {
  it("is a real report from an executed run, not a hand-written stub", () => {
    expect(report.state).toBe("complete");
    expect(report.tasks).toHaveLength(9);
    expect(report.artifacts.file_count).toBeGreaterThan(0);
    expect(report.metrics.tool_calls).toBeGreaterThan(0);
    expect(report.used_mock_provider).toBe(true);
    expect(report.delivered).toBe(false);
  });
});

describe("<DeliveryReportView />", () => {
  it("says plainly that a mocked run was not delivered", () => {
    render(<DeliveryReportView report={report} />);
    expect(screen.getByText("Not delivered as a real outcome")).toBeTruthy();
    expect(screen.queryByText("Delivered")).toBeNull();
    expect(screen.getByText(/This run used the offline mock provider/)).toBeTruthy();
    expect(screen.getByText(/It is never counted as a delivery/)).toBeTruthy();
  });

  it("shows the orchestrator's own summary and limitations", () => {
    render(<DeliveryReportView report={report} />);
    expect(screen.getByText(report.summary)).toBeTruthy();
    for (const line of report.limitations) {
      expect(screen.getByText(`· ${line}`)).toBeTruthy();
    }
  });

  it("renders each acceptance criterion with the real verdict and evidence", () => {
    render(<DeliveryReportView report={report} />);
    const section = screen.getByText("Acceptance criteria").parentElement as HTMLElement;
    for (const row of report.acceptance_criteria) {
      expect(within(section).getByText(row.criterion)).toBeTruthy();
      expect(within(section).getAllByText(row.status).length).toBeGreaterThan(0);
    }
    expect(within(section).getAllByText("pass").length).toBe(report.acceptance_criteria.length);
  });

  it("lists one row per executed task with its verification outcome", () => {
    render(<DeliveryReportView report={report} />);
    const table = screen.getByText("Task outcomes").parentElement?.querySelector("table") as HTMLTableElement;
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(report.tasks.length);
    // t7 had no automated verification command - it must read as n/a, not as a pass
    const unverified = rows.find((row) => within(row).queryByText("t7"));
    expect(unverified && within(unverified).queryByText("n/a")).toBeTruthy();
    expect(within(rows[0]).getByText("completed")).toBeTruthy();
  });

  it("reports the real metrics, including how many calls were mocked", () => {
    render(<DeliveryReportView report={report} />);
    expect(screen.getByText(`${report.metrics.task_counts.completed}/${report.tasks.length}`)).toBeTruthy();
    expect(screen.getByText(`${report.metrics.tool_calls_denied} denied by policy`)).toBeTruthy();
    expect(screen.getByText(`${report.metrics.decisions_escalated_to_llm} escalated to System 2`)).toBeTruthy();
    expect(screen.getByText(
      `$${report.metrics.cost_estimate.toFixed(2)} · ${report.metrics.mocked_calls} mocked`,
    )).toBeTruthy();
  });

  it("shows the artefacts that are really on disk", () => {
    render(<DeliveryReportView report={report} />);
    expect(screen.getByText(/files · hash/)).toBeTruthy();
    for (const file of report.artifacts.files.slice(0, 5)) {
      expect(screen.getByText(file.path)).toBeTruthy();
    }
  });

  it("shows the token budget actually consumed", () => {
    render(<DeliveryReportView report={report} />);
    expect(screen.getByText("Budget")).toBeTruthy();
    expect(screen.getByText(/plan tokens/)).toBeTruthy();
  });

  it("reads as delivered when the backend says so", () => {
    const delivered = { ...report, delivered: true, used_mock_provider: false };
    render(<DeliveryReportView report={delivered} />);
    expect(screen.getByText("Delivered")).toBeTruthy();
    expect(screen.queryByText(/This run used the offline mock provider/)).toBeNull();
  });

  it("tolerates a sparse report without inventing numbers", () => {
    const sparse = { ...report, acceptance_criteria: [], artifacts: { files: [], file_count: 0, workspace_hash: "" } };
    render(<DeliveryReportView report={sparse} />);
    expect(screen.getByText("The plan declared no acceptance criteria.")).toBeTruthy();
    expect(screen.getByText(/0 files · hash/)).toBeTruthy();
  });
});
