/** Vault list card for a single idea. */

import type { Idea } from '../lib/types';
import { roadmapProgress } from '../lib/roadmap';
import { Icon, ProgressBar, StagePill, TagChip, VerdictBadge } from './ui';

export function IdeaCard({
  idea,
  onOpen,
  onToggleStar,
  onDelete,
}: {
  idea: Idea;
  onOpen: () => void;
  onToggleStar: () => void;
  onDelete: () => void;
}) {
  const progress = roadmapProgress(idea.roadmap);
  const date = new Date(idea.createdAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(`Delete "${idea.title}"? This cannot be undone.`)) onDelete();
  };

  return (
    <article
      onClick={onOpen}
      className="cursor-pointer rounded-2xl border border-ink-700 bg-ink-900 p-4 transition hover:border-ink-600 active:scale-[0.99]"
    >
      <div className="flex items-start gap-2">
        <h3 className="line-clamp-2 flex-1 text-[15px] font-semibold leading-snug text-ivory">
          {idea.title}
        </h3>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar();
          }}
          aria-label={idea.starred ? 'Unstar' : 'Star'}
          className={`-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg transition ${
            idea.starred ? 'text-gold-400' : 'text-muted hover:text-ivory'
          }`}
        >
          <Icon name="star" className="w-5 h-5" filled={idea.starred} />
        </button>
        <button
          type="button"
          onClick={handleDelete}
          aria-label="Delete idea"
          className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:text-red-300"
        >
          <Icon name="trash" className="w-[18px] h-[18px]" />
        </button>
      </div>

      <p className="mt-1 text-xs text-muted">{date}</p>

      {idea.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {idea.tags.slice(0, 5).map((t) => (
            <TagChip key={t} tag={t} />
          ))}
          {idea.tags.length > 5 && (
            <span className="text-[11px] text-muted">+{idea.tags.length - 5}</span>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StagePill stage={idea.stage} />
        {idea.validation && <VerdictBadge verdict={idea.validation.verdict} />}
        {idea.roadmap && (
          <span className="text-[11px] font-medium text-muted">{progress}% roadmap</span>
        )}
      </div>

      {idea.roadmap && <ProgressBar value={progress} className="mt-2" />}
    </article>
  );
}
