/**
 * Area 6a - Projects: every workspace the company has actually created on disk.
 * A project only appears here after POST /api/objectives created it; deleting one
 * calls the real DELETE endpoint and only removes files when you explicitly ask.
 */
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FolderGit2, ExternalLink, Trash2 } from "lucide-react";
import { api, describeError } from "../api/client";
import { useResource } from "../lib/useResource";
import { useApp } from "../store/app";
import { Page } from "../components/Shell";
import {
  Badge, Button, CopyButton, EmptyState, ErrorState, Loading, Modal, Panel, Stat,
} from "../components/ui";
import { timeAgo } from "../lib/format";
import type { Project } from "../lib/types";

export function ProjectsArea() {
  const navigate = useNavigate();
  const pushToast = useApp((state) => state.pushToast);
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);
  const [removeFiles, setRemoveFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projects = useResource<{ items: Project[] }>(
    () => api.get<{ items: Project[] }>("/api/projects"),
    { refreshOn: ["project.", "plan.", "preview."], debounce: 800 },
  );

  const items = projects.data?.items ?? [];

  const destroy = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.del<{ deleted: boolean; files_removed: boolean }>(
        `/api/projects/${pendingDelete.id}`, { remove_files: removeFiles },
      );
      pushToast({
        title: "Project deleted",
        body: result.files_removed ? "Database rows and workspace files removed." : "Database rows removed; files kept on disk.",
        tone: "success",
      });
      setPendingDelete(null);
      projects.reload();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Projects" value={items.length} hint="one workspace per objective" />
        <Stat label="With a preview URL" value={items.filter((item) => item.preview_url).length}
              hint="detected dev server" />
        <Stat label="Newest" value={items[0] ? timeAgo(items[0].created_at) : "—"}
              hint={items[0]?.name ?? "no project yet"} />
      </div>

      <Panel
        title="Workspaces"
        subtitle="Each project owns a directory under workspaces/. Tools can never reach outside it."
        actions={<Link className="btn btn-sm" to="/command">New objective</Link>}
        bodyClassName="p-2"
      >
        {projects.loading && !projects.data && <Loading label="Loading projects" />}
        {projects.error && !projects.data && <ErrorState message={projects.error} onRetry={projects.reload} />}
        {!projects.loading && items.length === 0 && (
          <div className="p-2">
            <EmptyState
              title="No project yet"
              body="Give the company an objective in the Command Center. The CEO creates the workspace, plans the work and the builders fill it."
              action={<Link className="btn btn-sm btn-accent mt-1" to="/command">Open Command Center</Link>}
            />
          </div>
        )}
        <ul className="grid gap-2 md:grid-cols-2">
          {items.map((project) => (
            <li key={project.id} className="panel-flat p-3">
              <div className="flex items-start gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
                  <FolderGit2 size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <button type="button" className="truncate text-[14px] font-semibold hover:text-accent"
                            onClick={() => navigate(`/projects/${project.id}`)}>
                      {project.name}
                    </button>
                    <Badge tone={project.status === "delivered" ? "positive"
                      : project.status === "failed" ? "danger" : "muted"}>{project.status}</Badge>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-ink-soft">{project.objective}</p>
                  <p className="numeric mt-1.5 truncate text-[11px] text-ink-faint" title={project.workspace_path}>
                    {project.workspace_path}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={() => navigate(`/projects/${project.id}`)}>Open</Button>
                    {project.preview_url && (
                      <a className="btn btn-sm" href={project.preview_url} target="_blank" rel="noreferrer">
                        <ExternalLink size={12} /> Preview
                      </a>
                    )}
                    <CopyButton value={project.workspace_path} label="Path" />
                    <span className="numeric ml-auto text-[11px] text-ink-faint">{timeAgo(project.created_at)}</span>
                    <button type="button" className="btn btn-sm btn-danger" aria-label={`Delete ${project.name}`}
                            onClick={() => { setPendingDelete(project); setRemoveFiles(false); setError(null); }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <Modal open={Boolean(pendingDelete)} onClose={() => setPendingDelete(null)}
             title={`Delete ${pendingDelete?.name ?? "project"}`}>
        <p className="text-[13px] text-ink-soft">
          This removes the project row together with its plans, tasks and project memory.
          The audit trail keeps the record of the deletion.
        </p>
        <label className="mt-3 flex items-start gap-2 rounded-md border border-line bg-sunken/60 p-2.5 text-xs">
          <input type="checkbox" className="mt-0.5" checked={removeFiles}
                 onChange={(event) => setRemoveFiles(event.target.checked)} />
          <span>
            <span className="font-medium text-ink">Also delete the workspace directory</span>
            <span className="mt-0.5 block text-ink-faint numeric">{pendingDelete?.workspace_path}</span>
            <span className="mt-0.5 block text-ink-faint">
              Irreversible. Leave unchecked to keep the generated files on disk.
            </span>
          </span>
        </label>
        {error && <div className="mt-3"><ErrorState message={error} /></div>}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setPendingDelete(null)}>Cancel</Button>
          <Button variant="danger" busy={busy} onClick={() => void destroy()}>
            <Trash2 size={13} /> Delete project
          </Button>
        </div>
      </Modal>
    </Page>
  );
}
