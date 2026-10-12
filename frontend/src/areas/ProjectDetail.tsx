/**
 * Area 6b - Project detail: the real workspace.
 * Files are read from disk, tests are executed on demand, git output is the actual
 * repository state, the preview server is a real subprocess, and the delivery report
 * is the one the orchestrator generated from executed evidence.
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { clsx } from "clsx";
import {
  ExternalLink, FileCode2, FolderTree, GitCommitHorizontal, Play, RefreshCw, ShieldCheck,
  StopCircle,
} from "lucide-react";
import { ApiError, api, describeError } from "../api/client";
import { useResource } from "../lib/useResource";
import { useApp } from "../store/app";
import { BackLink, Page } from "../components/Shell";
import { DeliveryReportView } from "../components/DeliveryReport";
import { StatusDot } from "../components/TaskDetail";
import {
  Badge, Button, CopyButton, EmptyState, ErrorState, KeyValue, Loading, Panel, Stat,
} from "../components/ui";
import { bytes, duration, timeAgo, toneFor } from "../lib/format";
import type { DeliveryReport, PreviewStatus, Project } from "../lib/types";

type Tab = "files" | "tests" | "git" | "preview" | "security" | "report";

const TABS: { id: Tab; label: string; icon: typeof FileCode2 }[] = [
  { id: "files", label: "Files", icon: FolderTree },
  { id: "tests", label: "Tests", icon: Play },
  { id: "git", label: "Git", icon: GitCommitHorizontal },
  { id: "preview", label: "Preview", icon: ExternalLink },
  { id: "security", label: "Secrets", icon: ShieldCheck },
  { id: "report", label: "Delivery report", icon: FileCode2 },
];

interface TreeEntry { path: string; size: number }
interface FileResponse { path: string; content: string; size: number; truncated: boolean }
interface TestResult {
  command: string; code: number; passed: boolean; detected: boolean; stdout: string;
  stderr: string; duration_ms: number; sandbox: string; timed_out: boolean;
}
interface GitLog { repo: boolean; commits: { hash: string; author: string; date: string; subject: string }[]; count?: number }
interface GitDiff { repo: boolean; diff: string; code?: number; stderr?: string }
interface ScanResult { findings: { file: string; kind: string; excerpt: string }[]; count: number; clean: boolean }

export function ProjectDetail() {
  const { projectId = "" } = useParams();
  const [tab, setTab] = useState<Tab>("files");

  const project = useResource<Project>(() => api.get<Project>(`/api/projects/${projectId}`), {
    deps: [projectId], refreshOn: ["task.", "plan.", "preview.", "project."], debounce: 900,
  });

  if (project.loading && !project.data) return <Page><Loading label="Loading project" /></Page>;
  if (project.error && !project.data) {
    return (
      <Page>
        <BackLink to="/projects">Back to projects</BackLink>
        <div className="mt-3"><ErrorState message={project.error} onRetry={project.reload} /></div>
      </Page>
    );
  }
  const data = project.data;
  if (!data) return null;

  const done = (data.tasks ?? []).filter((task) => task.status === "completed").length;
  const total = (data.tasks ?? []).length;

  return (
    <Page className="space-y-4">
      <BackLink to="/projects">All projects</BackLink>

      <Panel
        title={data.name}
        subtitle={data.objective}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={data.status === "delivered" ? "positive" : data.status === "failed" ? "danger" : "muted"}>
              {data.status}
            </Badge>
            {data.preview_url && (
              <a className="btn btn-sm" href={data.preview_url} target="_blank" rel="noreferrer">
                <ExternalLink size={12} /> {data.preview_url}
              </a>
            )}
            <Button size="sm" onClick={project.reload}><RefreshCw size={12} /> Refresh</Button>
          </div>
        }
      >
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label="Tasks" value={`${done}/${total}`} hint="completed in this workspace" />
          <Stat label="Plans" value={(data.plans ?? []).length}
                hint={(data.plans ?? []).map((plan) => plan.state).join(", ") || "none"} />
          <Stat label="Preview" value={data.preview?.running ? "running" : "stopped"}
                hint={data.preview?.port ? `port ${data.preview.port}` : "no server detected"}
                tone={data.preview?.running ? "positive" : "muted"} />
          <Stat label="Report" value={data.report && Object.keys(data.report).length ? "generated" : "not yet"}
                hint={data.report?.delivered ? "delivered" : data.report ? "not delivered" : "run must finish first"}
                tone={data.report?.delivered ? "positive" : "muted"} />
        </div>
        <div className="mt-3">
          <KeyValue items={[
            ["Workspace", <span className="numeric">{data.workspace_path}</span>],
            ["Created", timeAgo(data.created_at)],
            ["Git branch", data.git_branch ? <span className="numeric">{data.git_branch}</span> : "no repository yet"],
          ]} />
        </div>
      </Panel>

      <div className="flex flex-wrap gap-1">
        {TABS.map((entry) => (
          <button key={entry.id} type="button" onClick={() => setTab(entry.id)}
                  className={clsx("btn btn-sm", tab === entry.id && "btn-accent")}>
            <entry.icon size={13} /> {entry.label}
          </button>
        ))}
      </div>

      {tab === "files" && <FilesTab projectId={projectId} />}
      {tab === "tests" && <TestsTab projectId={projectId} />}
      {tab === "git" && <GitTab projectId={projectId} />}
      {tab === "preview" && <PreviewTab projectId={projectId} onChanged={project.reload} />}
      {tab === "security" && <SecurityTab projectId={projectId} />}
      {tab === "report" && <ReportTab report={(data.report ?? null) as DeliveryReport | null} plans={data.plans ?? []} />}

      {(data.tasks ?? []).length > 0 && (
        <Panel title="Tasks that wrote to this workspace" bodyClassName="p-2">
          <ul className="space-y-1">
            {(data.tasks ?? []).map((task) => (
              <li key={task.id} className="flex items-center gap-2 rounded-md px-2.5 py-1.5 row-hover">
                <StatusDot status={task.status} />
                <span className="numeric w-14 shrink-0 text-[11px] text-ink-faint">{task.external_id}</span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{task.title}</span>
                <span className="numeric text-[11px] text-ink-faint">{task.agent_id ?? "—"}</span>
                {task.verification?.verified === true && <Badge tone="positive">verified</Badge>}
                {task.verification?.verified === false && <Badge tone="danger">unverified</Badge>}
                <span className="numeric text-[11px] text-ink-faint">{task.files_changed.length} file(s)</span>
                <Badge tone={toneFor("task", task.status)}>{task.status}</Badge>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </Page>
  );
}

function FilesTab({ projectId }: { projectId: string }) {
  const [path, setPath] = useState(".");
  const [selected, setSelected] = useState<string | null>(null);

  const tree = useResource<{ entries: TreeEntry[]; count: number; truncated: boolean }>(
    () => api.get(`/api/projects/${projectId}/tree`, { path }),
    { deps: [projectId, path], refreshOn: ["task.", "tool.result"], debounce: 800 },
  );
  const file = useResource<FileResponse | null>(
    async () => {
      if (!selected) return null;
      return api.get<FileResponse>(`/api/projects/${projectId}/file`, { path: selected });
    },
    { deps: [projectId, selected], enabled: Boolean(selected) },
  );

  const files = useMemo(() => (tree.data?.entries ?? []).filter((entry) => !entry.path.endsWith("/")), [tree.data]);

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <Panel
        title="Workspace tree"
        subtitle={tree.data ? `${tree.data.count} entries${tree.data.truncated ? " (truncated)" : ""}` : undefined}
        actions={<input className="field w-28" value={path} onChange={(event) => setPath(event.target.value)}
                        aria-label="Subdirectory" />}
        bodyClassName="p-2"
      >
        {tree.loading && !tree.data && <Loading label="Reading the workspace" />}
        {tree.error && <ErrorState message={tree.error} onRetry={tree.reload} />}
        {files.length === 0 && !tree.loading && (
          <div className="p-2">
            <EmptyState title="The workspace is empty"
                        body="Nothing has been written yet. Run an objective and the builders will fill this directory." />
          </div>
        )}
        <ul className="max-h-[520px] space-y-0.5 overflow-y-auto scroll-thin">
          {files.map((entry) => (
            <li key={entry.path}>
              <button type="button"
                      className={clsx("flex w-full items-center gap-2 rounded px-2 py-1 text-left row-hover",
                                      selected === entry.path && "bg-accent-soft")}
                      onClick={() => setSelected(entry.path)}>
                <FileCode2 size={12} className="shrink-0 text-ink-faint" />
                <span className="numeric min-w-0 flex-1 truncate text-xs">{entry.path}</span>
                <span className="numeric shrink-0 text-[11px] text-ink-faint">{bytes(entry.size)}</span>
              </button>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel
        title={selected ?? "File viewer"}
        subtitle={file.data ? `${bytes(file.data.size)}${file.data.truncated ? " · truncated to 200 KB" : ""}` : "Pick a file on the left"}
        actions={selected ? <CopyButton value={selected} label="Path" /> : undefined}
        bodyClassName="p-3"
      >
        {!selected && <EmptyState title="No file selected" body="File contents are read from disk on demand." />}
        {selected && file.loading && !file.data && <Loading label="Reading file" />}
        {selected && file.error && <ErrorState message={file.error} />}
        {file.data && (
          <pre className="code max-h-[560px] overflow-auto">{file.data.content}</pre>
        )}
      </Panel>
    </div>
  );
}

function TestsTab({ projectId }: { projectId: string }) {
  const pushToast = useApp((state) => state.pushToast);
  const [result, setResult] = useState<TestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const outcome = await api.get<TestResult>(`/api/projects/${projectId}/tests`);
      setResult(outcome);
      pushToast({
        title: outcome.passed ? "Tests passed" : "Tests did not pass",
        body: `${outcome.command || "no runner detected"} · exit ${outcome.code} · ${duration(outcome.duration_ms)}`,
        tone: outcome.passed ? "success" : "danger",
      });
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Panel
      title="Run the project's tests"
      subtitle="Executed now, in the project workspace, through the sandbox. Output is the real stdout/stderr."
      actions={<Button variant="accent" size="sm" busy={running} onClick={() => void run()}>
        <Play size={13} /> Run tests
      </Button>}
    >
      {error && <ErrorState message={error} />}
      {!result && !error && (
        <EmptyState
          title="Nothing executed yet"
          body="Press Run tests. The backend detects pytest (pytest.ini / tests/) or an npm test script and runs it with a timeout. Results are never inferred or faked."
        />
      )}
      {result && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={result.passed ? "positive" : "danger"}>
              {result.passed ? "passed" : "failed"} · exit {result.code}
            </Badge>
            {!result.detected && <Badge tone="warning">no test runner detected</Badge>}
            {result.timed_out && <Badge tone="danger">timed out</Badge>}
            <span className="numeric text-xs text-ink-faint">{duration(result.duration_ms)}</span>
            <span className="numeric text-xs text-ink-faint">sandbox: {result.sandbox}</span>
          </div>
          <KeyValue items={[["Command", <span className="numeric">{result.command || "(none detected)"}</span>]]} />
          {result.stdout && (
            <div>
              <p className="label">stdout</p>
              <pre className="code mt-1 max-h-80 overflow-auto">{result.stdout}</pre>
            </div>
          )}
          {result.stderr && (
            <div>
              <p className="label">stderr</p>
              <pre className="code mt-1 max-h-60 overflow-auto">{result.stderr}</pre>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function GitTab({ projectId }: { projectId: string }) {
  const [staged, setStaged] = useState(false);
  const log = useResource<GitLog>(() => api.get<GitLog>(`/api/projects/${projectId}/git/log`, { limit: 40 }), {
    deps: [projectId], refreshOn: ["task.", "git."], debounce: 1500,
  });
  const diff = useResource<GitDiff | null>(async () => {
    try {
      return await api.get<GitDiff>(`/api/projects/${projectId}/diff`, { staged });
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "no_repository") return { repo: false, diff: "" };
      throw cause;
    }
  }, { deps: [projectId, staged], refreshOn: ["task.", "git."], debounce: 1500 });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Commit history" subtitle={log.data?.repo ? `${log.data.commits.length} commit(s)` : "no repository in this workspace yet"}>
        {log.loading && !log.data && <Loading label="Reading git log" />}
        {log.error && <ErrorState message={log.error} onRetry={log.reload} />}
        {log.data && !log.data.repo && (
          <EmptyState title="No git repository"
                      body="The workspace has not been initialised with git. The builders commit when the plan includes a version-control task." />
        )}
        {log.data?.repo && log.data.commits.length === 0 && (
          <EmptyState title="No commits yet" body="The repository exists but nothing has been committed." />
        )}
        <ul className="space-y-1.5">
          {(log.data?.commits ?? []).map((commit) => (
            <li key={commit.hash} className="panel-flat px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className="numeric text-[11px] text-accent">{commit.hash.slice(0, 7)}</span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{commit.subject}</span>
              </div>
              <p className="numeric mt-0.5 text-[11px] text-ink-faint">{commit.author} · {commit.date}</p>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel
        title="Working tree diff"
        subtitle="git diff --no-color, run in the workspace"
        actions={
          <div className="flex gap-1">
            <Button size="sm" variant={staged ? "default" : "accent"} onClick={() => setStaged(false)}>Unstaged</Button>
            <Button size="sm" variant={staged ? "accent" : "default"} onClick={() => setStaged(true)}>Staged</Button>
          </div>
        }
      >
        {diff.loading && !diff.data && <Loading label="Running git diff" />}
        {diff.error && <ErrorState message={diff.error} onRetry={diff.reload} />}
        {diff.data && !diff.data.repo && <EmptyState title="No repository" body="Nothing to diff." />}
        {diff.data?.repo && !diff.data.diff.trim() && (
          <EmptyState title={staged ? "Nothing staged" : "Working tree is clean"}
                      body="No difference between the index and the files on disk." />
        )}
        {diff.data?.diff && <pre className="code max-h-[520px] overflow-auto">{diff.data.diff}</pre>}
      </Panel>
    </div>
  );
}

function PreviewTab({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const pushToast = useApp((state) => state.pushToast);
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const status = useResource<PreviewStatus>(() => api.get<PreviewStatus>(`/api/projects/${projectId}/preview`), {
    deps: [projectId], refreshOn: ["preview.", "task."], debounce: 1500,
  });

  const act = async (key: string, call: () => Promise<unknown>, message: string) => {
    setBusy(key);
    setError(null);
    try {
      await call();
      pushToast({ title: message, tone: "success" });
      status.reload();
      onChanged();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(null);
    }
  };

  const current = status.data;
  const logTail = (current?.log ?? current?.log_tail ?? "") as string | string[];
  const logText = Array.isArray(logTail) ? logTail.join("") : logTail;

  return (
    <Panel
      title="Dev server"
      subtitle="A real subprocess in the workspace, bound to 0.0.0.0 on a free port, with a scrubbed environment."
      actions={
        current?.running ? (
          <Button size="sm" variant="danger" busy={busy === "stop"}
                  onClick={() => void act("stop", () => api.post(`/api/projects/${projectId}/preview/stop`), "Preview stopped")}>
            <StopCircle size={13} /> Stop server
          </Button>
        ) : (
          <Button size="sm" variant="accent" busy={busy === "start"}
                  onClick={() => void act("start", () => api.post(`/api/projects/${projectId}/preview/start`, null,
                                                                  { command: command.trim() || undefined }), "Preview started")}>
            <Play size={13} /> Start server
          </Button>
        )
      }
    >
      <div className="space-y-3">
        {error && <ErrorState message={error} />}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="label">Command override</span>
            <input className="field numeric mt-1" value={command} placeholder="auto-detect (npm run dev / python -m http.server / uvicorn app:app)"
                   onChange={(event) => setCommand(event.target.value)} />
            <span className="mt-1 block text-xs text-ink-faint">
              Checked against the shell allowlist before it runs; a denied command returns 403 policy_denied.
            </span>
          </label>
          <div>
            <span className="label">Current state</span>
            <div className="mt-1">
              <KeyValue items={[
                ["Running", current?.running ? "yes" : "no"],
                ["Port", current?.port ? <span className="numeric">{current.port}</span> : "—"],
                ["Local URL", current?.local_url ? <span className="numeric">{current.local_url}</span> : "—"],
                ["Public URL", current?.public_url
                  ? <a className="numeric text-accent underline" href={current.public_url} target="_blank" rel="noreferrer">{current.public_url}</a>
                  : "—"],
                ["Command", current?.command ? <span className="numeric">{current.command}</span> : "—"],
                ["Exit code", <span className="numeric">{current?.exit_code ?? "—"}</span>],
              ]} />
            </div>
          </div>
        </div>
        {!current?.running && !error && (
          <EmptyState title="No server running"
                      body="Start it to smoke-test what the company built. The URL opens in a new tab; nothing is exposed beyond this machine unless you publish it." />
        )}
        {logText && (
          <div>
            <p className="label">Server output</p>
            <pre className="code mt-1 max-h-64 overflow-auto">{logText}</pre>
          </div>
        )}
      </div>
    </Panel>
  );
}

function SecurityTab({ projectId }: { projectId: string }) {
  const scan = useResource<ScanResult | null>(
    () => api.get<ScanResult>(`/api/projects/${projectId}/secrets-scan`),
    { deps: [projectId], refreshOn: ["task.", "plan.finished"], debounce: 2000 },
  );

  return (
    <Panel
      title="Secret scan"
      subtitle="Pattern scan of the workspace for keys, tokens and connection strings. Matches are reported by file and kind only - the value itself is never returned."
      actions={<Button size="sm" onClick={scan.reload}><RefreshCw size={12} /> Rescan</Button>}
    >
      {scan.loading && !scan.data && <Loading label="Scanning the workspace" />}
      {scan.error && <ErrorState message={scan.error} onRetry={scan.reload} />}
      {scan.data?.clean && (
        <div className="flex items-start gap-2 rounded-md border border-[#cfe8da] bg-positive-soft px-3 py-2.5 text-[13px] text-positive">
          <ShieldCheck size={15} className="mt-0.5 shrink-0" />
          <span>No secret pattern matched any file in this workspace.</span>
        </div>
      )}
      {scan.data && !scan.data.clean && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-md border border-[#f2cfcc] bg-danger-soft px-3 py-2 text-[13px] text-danger">
            <ShieldCheck size={14} /> {scan.data.count} finding(s). Remove them before publishing this project.
          </div>
          <ul className="space-y-1">
            {scan.data.findings.map((finding, index) => (
              <li key={`${finding.file}-${index}`} className="panel-flat flex items-center gap-3 px-3 py-2">
                <span className="numeric min-w-0 flex-1 truncate text-xs">{finding.file}</span>
                <Badge tone="danger">{finding.kind}</Badge>
                <span className="numeric text-[11px] text-ink-faint">{finding.excerpt}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function ReportTab({ report, plans }: {
  report: DeliveryReport | null;
  plans: { id: string; state: string; progress: number; objective: string; created_at: string | null }[];
}) {
  const hasReport = Boolean(report && Object.keys(report).length > 0);
  return (
    <div className="space-y-4">
      <Panel title="Delivery report" subtitle="Generated by the orchestrator from executed evidence only">
        {!hasReport && (
          <EmptyState
            title="No report for this project yet"
            body="A report is written when a run reaches the delivery stage. A run that used the offline mock provider is reported as delivered=false, and that is shown here rather than hidden."
          />
        )}
        {hasReport && report && <DeliveryReportView report={report} />}
      </Panel>

      <Panel title="Runs on this project" bodyClassName="p-2">
        {plans.length === 0 && <div className="p-2"><EmptyState title="No runs" body="No plan has been executed against this workspace." /></div>}
        <ul className="space-y-1">
          {plans.map((plan) => (
            <li key={plan.id}>
              <Link to="/command" className="flex items-center gap-2 rounded-md px-2.5 py-2 row-hover">
                <span className="numeric text-[11px] text-ink-faint">{plan.id.slice(0, 8)}</span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{plan.objective}</span>
                <span className="numeric text-[11px] text-ink-faint">{Math.round(plan.progress * 100)}%</span>
                <Badge tone={toneFor("plan", plan.state)}>{plan.state}</Badge>
                <span className="numeric text-[11px] text-ink-faint">{timeAgo(plan.created_at)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
