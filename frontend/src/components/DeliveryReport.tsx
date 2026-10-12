/** The delivery report - rendered exactly as the backend produced it. */
import { Check, ShieldAlert, TriangleAlert, X } from "lucide-react";
import { Badge } from "./ui";
import { bytes, compactNumber, money, percent } from "../lib/format";
import type { DeliveryReport } from "../lib/types";

export function DeliveryReportView({ report }: { report: DeliveryReport }) {
  const counts = report.metrics?.task_counts ?? {};
  return (
    <div className="space-y-4">
      <div className={report.delivered
        ? "flex items-start gap-2 rounded-md border border-[#cfe8da] bg-positive-soft px-3 py-2 text-[13px] text-positive"
        : "flex items-start gap-2 rounded-md border border-[#f0dfba] bg-warning-soft px-3 py-2 text-[13px] text-warning"}>
        {report.delivered ? <Check size={15} className="mt-0.5 shrink-0" /> : <TriangleAlert size={15} className="mt-0.5 shrink-0" />}
        <div>
          <p className="font-semibold">
            {report.delivered ? "Delivered" : "Not delivered as a real outcome"}
          </p>
          <p className="mt-0.5 text-ink-soft">{report.summary}</p>
        </div>
      </div>

      {report.used_mock_provider && (
        <div className="flex items-start gap-2 rounded-md border border-[#f2cfcc] bg-danger-soft px-3 py-2 text-[13px] text-danger">
          <ShieldAlert size={15} className="mt-0.5 shrink-0" />
          <span>
            This run used the offline mock provider. It exercised the real pipeline - planning, scheduling,
            tools, verification - but the artefacts are stubs. It is never counted as a delivery.
          </span>
        </div>
      )}

      <section>
        <p className="label">Limitations recorded by the orchestrator</p>
        <ul className="mt-1 space-y-1 text-[13px] text-ink-soft">
          {(report.limitations ?? []).map((line) => <li key={line}>· {line}</li>)}
        </ul>
      </section>

      <section>
        <p className="label">Acceptance criteria</p>
        <ul className="mt-1.5 space-y-1">
          {(report.acceptance_criteria ?? []).map((row, index) => (
            <li key={`${row.criterion}-${index}`} className="flex items-start gap-2 text-[13px]">
              <span className="mt-0.5">
                {row.status === "pass" ? <Check size={13} className="text-positive" />
                  : row.status === "fail" ? <X size={13} className="text-danger" />
                    : <TriangleAlert size={13} className="text-warning" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block">{row.criterion}</span>
                {row.evidence && <span className="numeric block text-[11px] text-ink-faint">{row.evidence}</span>}
              </span>
              <Badge tone={row.status === "pass" ? "positive" : row.status === "fail" ? "danger" : "warning"}>
                {row.status}
              </Badge>
            </li>
          ))}
          {(report.acceptance_criteria ?? []).length === 0 && (
            <li className="text-xs text-ink-faint">The plan declared no acceptance criteria.</li>
          )}
        </ul>
      </section>

      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="Tasks" value={`${counts.completed ?? 0}/${(report.tasks ?? []).length}`}
                hint={`${counts.failed ?? 0} failed · ${counts.blocked ?? 0} blocked`} />
        <Metric label="Tool calls" value={compactNumber(report.metrics?.tool_calls ?? 0)}
                hint={`${report.metrics?.tool_calls_denied ?? 0} denied by policy`} />
        <Metric label="Decisions" value={compactNumber(report.metrics?.decisions ?? 0)}
                hint={`${report.metrics?.decisions_escalated_to_llm ?? 0} escalated to System 2`} />
        <Metric label="Tokens" value={compactNumber((report.metrics?.tokens_in ?? 0) + (report.metrics?.tokens_out ?? 0))}
                hint={`${money(report.metrics?.cost_estimate)} · ${report.metrics?.mocked_calls ?? 0} mocked`} />
      </section>

      <section>
        <p className="label">Task outcomes</p>
        <div className="mt-1.5 overflow-x-auto scroll-thin">
          <table className="w-full min-w-[560px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="py-1.5 pr-2 font-medium">id</th>
                <th className="py-1.5 pr-2 font-medium">title</th>
                <th className="py-1.5 pr-2 font-medium">agent</th>
                <th className="py-1.5 pr-2 font-medium">status</th>
                <th className="py-1.5 pr-2 font-medium">verified</th>
                <th className="py-1.5 font-medium">files</th>
              </tr>
            </thead>
            <tbody>
              {(report.tasks ?? []).map((task) => (
                <tr key={task.id} className="border-b border-line-soft last:border-0">
                  <td className="numeric py-1.5 pr-2 text-ink-faint">{task.id}</td>
                  <td className="max-w-[280px] truncate py-1.5 pr-2">{task.title}</td>
                  <td className="py-1.5 pr-2 text-ink-soft">{task.agent_id ?? "—"}</td>
                  <td className="py-1.5 pr-2">
                    <Badge tone={task.status === "completed" ? "positive" : task.status === "cancelled" ? "muted" : "danger"}>
                      {task.status}
                    </Badge>
                  </td>
                  <td className="py-1.5 pr-2">
                    {task.verified === true ? <Check size={13} className="text-positive" />
                      : task.verified === false ? <X size={13} className="text-danger" />
                        : <span className="text-xs text-ink-faint">n/a</span>}
                  </td>
                  <td className="numeric py-1.5 text-ink-faint">{task.files_changed?.length ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between">
          <p className="label">Artefacts</p>
          <span className="numeric text-[11px] text-ink-faint">
            {report.artifacts?.file_count ?? 0} files · hash {String(report.artifacts?.workspace_hash ?? "").slice(0, 12)}
          </span>
        </div>
        <ul className="mt-1.5 grid gap-1 sm:grid-cols-2">
          {(report.artifacts?.files ?? []).slice(0, 60).map((file) => (
            <li key={file.path} className="numeric flex items-center justify-between gap-2 border-b border-line-soft py-0.5 text-[12px]">
              <span className="truncate">{file.path}</span>
              <span className="shrink-0 text-ink-faint">{bytes(file.size)}</span>
            </li>
          ))}
        </ul>
      </section>

      {report.metrics?.tokens_plan_budget !== undefined && (
        <section>
          <p className="label">Budget</p>
          <p className="numeric mt-1 text-[12px] text-ink-faint">
            {compactNumber(report.metrics.tokens_used ?? 0)} / {compactNumber(report.metrics.tokens_plan_budget ?? 0)} plan tokens
            {" · "}
            {compactNumber(report.metrics.tokens_global_budget ?? 0)} global · {percent(
              (report.metrics.tokens_used ?? 0) / Math.max(1, report.metrics.tokens_plan_budget ?? 1),
            )} used
          </p>
        </section>
      )}
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="panel-flat px-3 py-2">
      <p className="label">{label}</p>
      <p className="numeric mt-0.5 text-[17px] font-semibold">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-ink-faint">{hint}</p>}
    </div>
  );
}
