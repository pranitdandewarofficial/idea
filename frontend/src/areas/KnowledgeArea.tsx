/**
 * Area 8 - Knowledge Center: reference material the agents may retrieve.
 * Uploads are chunked and indexed server-side; retrieval is BM25 over those chunks.
 * Retrieved text is injected into prompts as clearly-labelled untrusted evidence,
 * never as instructions.
 */
import { useRef, useState } from "react";
import { BookOpen, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { api, describeError } from "../api/client";
import { useResource } from "../lib/useResource";
import { useApp } from "../store/app";
import { Page } from "../components/Shell";
import {
  Badge, Button, EmptyState, ErrorState, Field, KeyValue, Loading, Panel, Stat,
} from "../components/ui";
import { bytes, timeAgo } from "../lib/format";
import type { KnowledgeSearchResponse, KnowledgeSource, KnowledgeStats } from "../lib/types";

const ACCEPTED = ".md,.txt,.rst,.pdf,.py,.ts,.tsx,.js,.jsx,.json,.yml,.yaml,.toml,.html,.css,.sh,.csv,.log";

const INDEX_TONE: Record<string, "positive" | "warning" | "danger" | "muted"> = {
  indexed: "positive",
  ready: "positive",
  partial: "warning",
  failed: "danger",
  pending: "muted",
};

export function KnowledgeArea() {
  const pushToast = useApp((state) => state.pushToast);
  const fileInput = useRef<HTMLInputElement>(null);
  const [tags, setTags] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [limit, setLimit] = useState(5);
  const [busyId, setBusyId] = useState<string | null>(null);

  const sources = useResource<{ items: KnowledgeSource[]; count: number }>(
    () => api.get<{ items: KnowledgeSource[]; count: number }>("/api/knowledge"),
    { refreshOn: ["knowledge."], debounce: 900 },
  );
  const stats = useResource<KnowledgeStats>(() => api.get<KnowledgeStats>("/api/knowledge/stats"), {
    refreshOn: ["knowledge."], debounce: 1500,
  });
  const results = useResource<KnowledgeSearchResponse | null>(
    async () => {
      if (!searched.trim()) return null;
      return api.get<KnowledgeSearchResponse>("/api/knowledge/search", {
        q: searched.trim(), limit, tags: tagFilter || undefined,
      });
    },
    { deps: [searched, tagFilter, limit], enabled: Boolean(searched.trim()) },
  );

  const items = sources.data?.items ?? [];
  const allTags = [...new Set(items.flatMap((source) => source.tags))].sort();

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        form.append("tags", tags);
        const created = await api.upload<KnowledgeSource>("/api/knowledge/upload", form);
        pushToast({
          title: `Indexed ${created.name}`,
          body: `${created.chunk_count} chunks · ${created.index_status}`,
          tone: created.index_status === "failed" ? "warning" : "success",
        });
      }
      setTags("");
      if (fileInput.current) fileInput.current.value = "";
      sources.reload();
      stats.reload();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setUploading(false);
    }
  };

  const reindex = async (source: KnowledgeSource) => {
    setBusyId(source.id);
    setError(null);
    try {
      const result = await api.post<{ id: string; name: string; chunk_count: number; index_status: string }>(
        `/api/knowledge/${source.id}/reindex`,
      );
      pushToast({
        title: `Re-indexed ${result.name}`,
        body: `${result.chunk_count} chunks · ${result.index_status}`,
        tone: result.index_status === "failed" ? "warning" : "success",
      });
      sources.reload();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (source: KnowledgeSource) => {
    if (!window.confirm(`Delete "${source.name}" and its ${source.chunk_count} indexed chunks?`)) return;
    setBusyId(source.id);
    setError(null);
    try {
      await api.del(`/api/knowledge/${source.id}`);
      pushToast({ title: "Source deleted", body: source.name, tone: "success" });
      sources.reload();
      stats.reload();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Page className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Sources" value={stats.data?.sources ?? items.length} hint="documents indexed" />
        <Stat label="Chunks" value={stats.data?.chunks ?? "—"} hint="retrievable passages" />
        <Stat label="Size" value={bytes(stats.data?.bytes ?? 0)} hint="raw bytes stored" />
        <Stat label="Retrieval" value={stats.data?.engine ?? "keyword-bm25"}
              hint={stats.data?.embedding_model ? `embeddings: ${stats.data.embedding_model}` : "no embedding model - lexical search"} />
      </div>

      {error && <ErrorState message={error} />}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <Panel title="Add reference material" subtitle="Stored locally, chunked, indexed. Nothing is uploaded to a third party.">
          <div className="space-y-3">
            <Field label="File" hint={`Accepted: ${ACCEPTED.split(",").join(" ")}`}>
              <input
                ref={fileInput}
                className="field"
                type="file"
                accept={ACCEPTED}
                multiple
                onChange={(event) => void upload(event.target.files)}
              />
            </Field>
            <Field label="Tags" hint="Comma separated. Tags scope retrieval for a search.">
              <input className="field" value={tags} placeholder="api, conventions, python"
                     onChange={(event) => setTags(event.target.value)} />
            </Field>
            <div className="flex items-center gap-2">
              <Button variant="accent" busy={uploading} onClick={() => fileInput.current?.click()}>
                <Upload size={13} /> Choose and index
              </Button>
              {allTags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {allTags.map((tag) => (
                    <button key={tag} type="button" onClick={() => setTags((current) =>
                      current.split(",").map((value) => value.trim()).filter(Boolean).includes(tag)
                        ? current
                        : [current, tag].filter(Boolean).join(", "))}>
                      <Badge tone="muted">{tag}</Badge>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <p className="text-xs text-ink-faint">
              PDFs are indexed as raw bytes when no text layer can be extracted - the source then reports
              <span className="numeric"> index_status=failed</span> with the real reason instead of pretending to be searchable.
            </p>
          </div>
        </Panel>

        <Panel
          title="Search the knowledge base"
          subtitle="The same retrieval the agents use when a task needs reference material."
          actions={
            <div className="flex items-center gap-2">
              <select className="field w-auto" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}
                      aria-label="Filter by tag">
                <option value="">All tags</option>
                {allTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
              </select>
              <select className="field w-auto" value={limit} onChange={(event) => setLimit(Number(event.target.value))}
                      aria-label="Result count">
                {[3, 5, 10, 25].map((value) => <option key={value} value={value}>{value} results</option>)}
              </select>
            </div>
          }
        >
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setSearched(query);
            }}
          >
            <input className="field" value={query} placeholder="How should the API report errors?"
                   onChange={(event) => setQuery(event.target.value)} aria-label="Search knowledge" />
            <Button type="submit" variant="accent" disabled={!query.trim()}>
              <Search size={13} /> Search
            </Button>
          </form>

          <div className="mt-3 space-y-2">
            {results.loading && !results.data && <Loading label="Searching" />}
            {results.error && <ErrorState message={results.error} />}
            {!searched && (
              <EmptyState title="Nothing searched yet"
                          body="Type a question and press Search. Scores are BM25 over the indexed chunks." />
            )}
            {results.data?.note && (
              <p className="text-xs text-warning">{results.data.note}</p>
            )}
            {results.data && results.data.results.length === 0 && !results.data.note && (
              <EmptyState title="No passage matched"
                          body="BM25 found no overlapping terms. Try different wording, or index a document that covers it." />
            )}
            {(results.data?.results ?? []).map((hit, index) => (
              <article key={`${hit.source_id}-${hit.position}-${index}`} className="panel-flat p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="accent"><BookOpen size={10} /> {hit.source_name}</Badge>
                  <span className="numeric text-[11px] text-ink-faint">chunk #{hit.position}</span>
                  <span className="numeric ml-auto text-[11px] text-ink-faint">score {hit.score.toFixed(3)}</span>
                </div>
                {hit.tags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {hit.tags.map((tag) => <Badge key={tag} tone="muted">{tag}</Badge>)}
                  </div>
                )}
                <p className="mt-1.5 whitespace-pre-wrap text-[13px] text-ink-soft">{hit.text}</p>
              </article>
            ))}
          </div>
        </Panel>
      </div>

      <Panel
        title="Indexed sources"
        subtitle="Chunk counts and index status are the real results of the ingest pipeline."
        actions={<Button size="sm" onClick={() => { sources.reload(); stats.reload(); }}><RefreshCw size={12} /> Refresh</Button>}
        bodyClassName="p-2"
      >
        {sources.loading && !sources.data && <Loading label="Loading sources" />}
        {sources.error && !sources.data && <ErrorState message={sources.error} onRetry={sources.reload} />}
        {!sources.loading && items.length === 0 && (
          <div className="p-2">
            <EmptyState title="The knowledge base is empty"
                        body="Upload a coding standard, an API reference or a design brief. Agents retrieve from here when a task needs it." />
          </div>
        )}
        <ul className="space-y-1">
          {items.map((source) => (
            <li key={source.id} className="panel-flat p-3">
              <div className="flex flex-wrap items-start gap-3">
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[13px] font-medium">{source.name}</span>
                    <Badge tone="muted">{source.kind}</Badge>
                    <Badge tone={INDEX_TONE[source.index_status] ?? "muted"}>{source.index_status}</Badge>
                  </span>
                  <span className="numeric mt-1 block text-[11px] text-ink-faint">
                    {source.chunk_count} chunks · {bytes(source.size_bytes)} · checksum {source.checksum.slice(0, 12)} ·{" "}
                    {timeAgo(source.created_at)}
                  </span>
                  {source.error && <span className="mt-1 block text-xs text-danger">{source.error}</span>}
                  {source.tags.length > 0 && (
                    <span className="mt-1.5 flex flex-wrap gap-1">
                      {source.tags.map((tag) => (
                        <button key={tag} type="button" onClick={() => { setTagFilter(tag); setSearched(query || tag); }}>
                          <Badge tone={tagFilter === tag ? "accent" : "muted"}>{tag}</Badge>
                        </button>
                      ))}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 gap-1.5">
                  <Button size="sm" busy={busyId === source.id} onClick={() => void reindex(source)}>
                    <RefreshCw size={12} /> Re-index
                  </Button>
                  <Button size="sm" variant="danger" busy={busyId === source.id} onClick={() => void remove(source)}
                          title="Delete this source">
                    <Trash2 size={12} />
                  </Button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="How retrieval is used" subtitle="So the boundary is explicit">
        <KeyValue items={[
          ["Engine", <span className="numeric">{stats.data?.engine ?? "keyword-bm25"}</span>],
          ["Embeddings", stats.data?.embedding_model
            ? <span className="numeric">{stats.data.embedding_model}</span>
            : "none - lexical scoring only, which is honest about what it can find"],
          ["Prompt handling", "retrieved passages are wrapped as untrusted evidence with their source name; they are never treated as instructions"],
          ["Guardrail", "the same injection and secret-leak checks that apply to model output apply to retrieved text"],
          ["Storage", "raw bytes plus chunks live in the local SQLite database; nothing leaves the machine"],
        ]} />
      </Panel>
    </Page>
  );
}
