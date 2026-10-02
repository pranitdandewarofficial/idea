/** Idea detail: header, inline edit, voice playback, stage selector, Validate/Roadmap tabs. */

import { useState } from 'react';
import {
  STAGES,
  type AISettings,
  type Idea,
  type Roadmap,
  type ValidationResult,
} from '../lib/types';
import { RoadmapPanel } from './RoadmapPanel';
import { ValidatePanel } from './ValidatePanel';
import { Field, GhostButton, Icon, PrimaryButton, SelectWrap, StagePill, TagChip, VerdictBadge, inputClass, selectClass } from './ui';

export function IdeaDetail({
  idea,
  settings,
  onBack,
  onUpdate,
  onToggleCheck,
}: {
  idea: Idea;
  settings: AISettings;
  onBack: () => void;
  onUpdate: (patch: Partial<Idea>) => void;
  onToggleCheck: (stageIdx: number, itemId: string) => void;
}) {
  const [tab, setTab] = useState<'validate' | 'roadmap'>('validate');
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(idea.title);
  const [editDesc, setEditDesc] = useState(idea.description);
  const [editTags, setEditTags] = useState(idea.tags.join(', '));

  const startEdit = () => {
    setEditTitle(idea.title);
    setEditDesc(idea.description);
    setEditTags(idea.tags.join(', '));
    setEditing(true);
  };

  const saveEdit = () => {
    if (!editTitle.trim()) return;
    onUpdate({
      title: editTitle.trim(),
      description: editDesc.trim(),
      tags: editTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    });
    setEditing(false);
  };

  const handleValidation = (v: ValidationResult) => onUpdate({ validation: v });
  const handleRoadmap = (r: Roadmap) => onUpdate({ roadmap: r });

  const tabBtn = (id: 'validate' | 'roadmap', label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setTab(id)}
      className={`flex min-h-[44px] flex-1 items-center justify-center rounded-xl px-4 py-2.5 text-sm font-bold transition ${
        tab === id ? 'bg-gold-400 text-ink-950' : 'text-muted hover:text-ivory'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex min-h-[44px] items-center gap-1 rounded-lg px-2 text-sm font-semibold text-muted hover:text-ivory"
        >
          <Icon name="back" className="w-4 h-4" />
          Vault
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => onUpdate({ starred: !idea.starred })}
          aria-label={idea.starred ? 'Unstar' : 'Star'}
          className={`-m-1 flex h-11 w-11 items-center justify-center rounded-lg ${idea.starred ? 'text-gold-400' : 'text-muted hover:text-ivory'}`}
        >
          <Icon name="star" className="w-5 h-5" filled={idea.starred} />
        </button>
      </div>

      <div className="rounded-2xl border border-ink-700 bg-ink-900 p-4">
        {editing ? (
          <div className="space-y-3">
            <Field label="Title">
              <input
                className={inputClass}
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
              />
            </Field>
            <Field label="Description">
              <textarea
                className={`${inputClass} min-h-[100px] resize-y`}
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
              />
            </Field>
            <Field label="Tags (comma-separated)">
              <input
                className={inputClass}
                value={editTags}
                onChange={(e) => setEditTags(e.target.value)}
              />
            </Field>
            <div className="flex gap-2">
              <GhostButton onClick={() => setEditing(false)} className="flex-1">
                Cancel
              </GhostButton>
              <PrimaryButton onClick={saveEdit} disabled={!editTitle.trim()} className="flex-1">
                Save changes
              </PrimaryButton>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <h2 className="flex-1 text-xl font-bold leading-tight text-ivory">{idea.title}</h2>
              <button
                type="button"
                onClick={startEdit}
                aria-label="Edit idea"
                className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-ink-800 hover:text-ivory"
              >
                <Icon name="pencil" className="w-4 h-4" />
              </button>
            </div>
            {idea.description && (
              <p className="mt-2 text-sm leading-relaxed text-muted">{idea.description}</p>
            )}
            {idea.tags.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {idea.tags.map((t) => (
                  <TagChip key={t} tag={t} />
                ))}
              </div>
            )}
          </>
        )}

        {idea.voiceNote && (
          <div className="mt-3 rounded-xl border border-ink-600 bg-ink-800 p-3">
            <p className="mb-1.5 text-xs font-semibold text-muted">
              Voice note · {Math.floor(idea.voiceNote.durationSec / 60)}:
              {String(idea.voiceNote.durationSec % 60).padStart(2, '0')}
            </p>
            <audio controls src={idea.voiceNote.dataUrl} className="w-full" />
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-ink-700 pt-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">Stage</span>
          <SelectWrap>
            <select
              value={idea.stage}
              onChange={(e) => onUpdate({ stage: e.target.value as Idea['stage'] })}
              className={selectClass}
              aria-label="Pipeline stage"
            >
              {STAGES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </SelectWrap>
          <StagePill stage={idea.stage} />
          {idea.validation && <VerdictBadge verdict={idea.validation.verdict} />}
          <span className="ml-auto text-[11px] text-muted">
            {new Date(idea.createdAt).toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
          </span>
        </div>
      </div>

      <div className="sticky top-2 z-10 mt-4 flex gap-1 rounded-2xl border border-ink-700 bg-ink-900 p-1 shadow-lg shadow-black/30">
        {tabBtn('validate', 'Validate')}
        {tabBtn('roadmap', 'Roadmap')}
      </div>

      <div className="mt-4">
        <div className={tab === 'validate' ? '' : 'hidden'}>
          <ValidatePanel idea={idea} settings={settings} onValidation={handleValidation} />
        </div>
        <div className={tab === 'roadmap' ? '' : 'hidden'}>
          <RoadmapPanel
            idea={idea}
            settings={settings}
            onRoadmap={handleRoadmap}
            onToggleCheck={onToggleCheck}
          />
        </div>
      </div>
    </div>
  );
}
