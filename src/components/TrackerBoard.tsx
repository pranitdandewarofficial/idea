/** Tracker: kanban of the 6 pipeline stages with drag-and-drop + arrow moves. */

import { useState } from 'react';
import { STAGES, type Idea, type StageId } from '../lib/types';
import { roadmapProgress } from '../lib/roadmap';
import { EmptyState, Icon, ProgressBar, StagePill, VerdictBadge } from './ui';

function Card({
  idea,
  index,
  total,
  dragging,
  onOpen,
  onMove,
  onDragStart,
  onDragEnd,
}: {
  idea: Idea;
  index: number;
  total: number;
  dragging: boolean;
  onOpen: () => void;
  onMove: (dir: -1 | 1) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const progress = roadmapProgress(idea.roadmap);
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', idea.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={`cursor-grab rounded-xl border border-ink-700 bg-ink-900 p-3 transition hover:border-ink-600 active:cursor-grabbing ${
        dragging ? 'scale-[0.97] border-gold-400/50 opacity-50 shadow-lg shadow-black/40' : ''
      }`}
    >
      <p className="line-clamp-2 text-sm font-semibold leading-snug text-ivory">{idea.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {idea.validation && <VerdictBadge verdict={idea.validation.verdict} />}
        {idea.roadmap && <span className="text-[11px] text-muted">{progress}%</span>}
      </div>
      {idea.roadmap && <ProgressBar value={progress} className="mt-2" />}
      <div className="mt-2 flex items-center justify-between border-t border-ink-700 pt-2">
        <button
          type="button"
          aria-label="Move left"
          onClick={(e) => {
            e.stopPropagation();
            onMove(-1);
          }}
          disabled={index === 0}
          className="-m-1 flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-ink-800 hover:text-ivory disabled:opacity-30"
        >
          <Icon name="chevronLeft" className="w-4 h-4" />
        </button>
        <span className="text-[11px] text-muted">
          {new Date(idea.updatedAt).toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'short',
          })}
        </span>
        <button
          type="button"
          aria-label="Move right"
          onClick={(e) => {
            e.stopPropagation();
            onMove(1);
          }}
          disabled={index === total - 1}
          className="-m-1 flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-ink-800 hover:text-ivory disabled:opacity-30"
        >
          <Icon name="chevronRight" className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export function TrackerBoard({
  ideas,
  onOpen,
  onMoveStage,
  onDropStage,
}: {
  ideas: Idea[];
  onOpen: (id: string) => void;
  onMoveStage: (id: string, dir: -1 | 1) => void;
  onDropStage: (id: string, stage: StageId) => void;
}) {
  const [dragOver, setDragOver] = useState<StageId | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  if (ideas.length === 0) {
    return (
      <EmptyState
        icon="kanban"
        art="kanban"
        title="No ideas yet"
        hint="Capture your first idea in the Vault to start tracking it."
      />
    );
  }

  return (
    <div className="scroll-thin -mx-4 flex gap-3 overflow-x-auto px-4 pb-4">
      {STAGES.map((stage, index) => {
        const col = ideas.filter((i) => i.stage === stage.id);
        return (
          <section
            key={stage.id}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDragOver(stage.id);
            }}
            onDragLeave={() => setDragOver((d) => (d === stage.id ? null : d))}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(null);
              const id = e.dataTransfer.getData('text/plain');
              if (id) onDropStage(id, stage.id);
            }}
            className={`flex w-[260px] shrink-0 flex-col rounded-2xl border bg-ink-900/60 p-3 transition ${
              dragOver === stage.id ? 'border-gold-400/60' : 'border-ink-700'
            }`}
          >
            <header className="mb-3 flex items-center gap-2">
              <StagePill stage={stage.id} />
              <span className="rounded-full bg-ink-800 px-2 py-0.5 text-[11px] font-bold text-muted">
                {col.length}
              </span>
            </header>
            <div className="space-y-2">
              {col.map((idea) => (
                <Card
                  key={idea.id}
                  idea={idea}
                  index={index}
                  total={STAGES.length}
                  dragging={draggingId === idea.id}
                  onOpen={() => onOpen(idea.id)}
                  onMove={(dir) => onMoveStage(idea.id, dir)}
                  onDragStart={() => setDraggingId(idea.id)}
                  onDragEnd={() => setDraggingId(null)}
                />
              ))}
              {col.length === 0 && (
                <p className="rounded-xl border border-dashed border-ink-600 px-3 py-6 text-center text-xs text-muted">
                  Drop ideas here
                </p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
