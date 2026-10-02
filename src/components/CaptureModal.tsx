/** Capture modal: title, description, tags, optional voice note via MediaRecorder. */

import { useEffect, useRef, useState } from 'react';
import type { VoiceNote } from '../lib/types';
import { Field, GhostButton, Icon, PrimaryButton, inputClass } from './ui';

export interface CaptureData {
  title: string;
  description: string;
  tags: string[];
  voiceNote?: VoiceNote;
}

const recorderSupported =
  typeof window !== 'undefined' &&
  typeof window.MediaRecorder !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia;

export function CaptureModal({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (data: CaptureData) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [recState, setRecState] = useState<'idle' | 'recording' | 'done'>('idle');
  const [recSecs, setRecSecs] = useState(0);
  const [recError, setRecError] = useState<string | null>(null);
  const [voiceNote, setVoiceNote] = useState<VoiceNote | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const startRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      if (recorderRef.current?.state === 'recording') {
        try {
          recorderRef.current.stop();
        } catch {
          /* ignore */
        }
      }
      stopTracks();
    };
  }, []);

  // Escape closes; lock body scroll while the sheet is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // After the software keyboard settles, nudge the focused field into view.
  const nudgeIntoView = (e: React.FocusEvent<HTMLElement>) => {
    const el = e.currentTarget;
    window.setTimeout(() => {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 350);
  };

  const startRecording = async () => {
    setRecError(null);
    if (!recorderSupported) {
      setRecError('Voice recording is not supported in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const rec = new MediaRecorder(stream);
      recorderRef.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        const secs = Math.max(1, Math.round((Date.now() - startRef.current) / 1000));
        const reader = new FileReader();
        reader.onload = () => {
          setVoiceNote({
            mime: blob.type || 'audio/webm',
            dataUrl: String(reader.result ?? ''),
            durationSec: secs,
          });
          setRecState('done');
        };
        reader.onerror = () => setRecError('Could not read the recording. Try again.');
        reader.readAsDataURL(blob);
        stopTracks();
      };
      rec.onerror = () => setRecError('Recording failed. Try again.');
      startRef.current = Date.now();
      setRecSecs(0);
      rec.start();
      setRecState('recording');
      timerRef.current = window.setInterval(() => {
        setRecSecs(Math.round((Date.now() - startRef.current) / 1000));
      }, 1000);
    } catch {
      setRecError('Microphone access denied. Allow microphone permission to record a voice note.');
    }
  };

  const stopRecording = () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  };

  const removeVoiceNote = () => {
    setVoiceNote(null);
    setRecState('idle');
    setRecSecs(0);
  };

  const handleSave = () => {
    if (!title.trim()) return;
    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    onSave({
      title: title.trim(),
      description: description.trim(),
      tags,
      ...(voiceNote ? { voiceNote } : {}),
    });
  };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/70"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Capture new idea"
    >
      <div className="flex min-h-full items-end justify-center sm:items-center sm:p-4">
        <div
          className="w-full max-w-lg rounded-t-3xl border border-ink-700 bg-ink-900 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:rounded-3xl sm:pb-5"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink-600 sm:hidden" aria-hidden="true" />
          <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-ivory">Capture idea</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-2 flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-ink-800 hover:text-ivory"
          >
            <Icon name="x" className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          <Field label="Title">
            <input
              className={inputClass}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onFocus={nudgeIntoView}
              placeholder="e.g. UPI-based micro-lending for street vendors"
              autoFocus
              enterKeyHint="next"
            />
          </Field>

          <Field label="Description">
            <textarea
              className={`${inputClass} min-h-[110px] resize-y`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onFocus={nudgeIntoView}
              placeholder="What is it? Who is it for? Why would they pay?"
            />
          </Field>

          <Field label="Tags" hint="Comma-separated, e.g. fintech, b2b, saas">
            <input
              className={inputClass}
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              onFocus={nudgeIntoView}
              placeholder="fintech, b2b"
              enterKeyHint="done"
            />
          </Field>

          <div>
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted">
              Voice note (optional)
            </span>
            {recState === 'idle' && (
              <GhostButton onClick={startRecording} className="w-full">
                <Icon name="mic" className="w-4 h-4" />
                Record voice note
              </GhostButton>
            )}
            {recState === 'recording' && (
              <div className="flex items-center gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2.5">
                <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-400" />
                <span className="flex-1 text-sm font-semibold text-red-200">
                  Recording… {fmt(recSecs)}
                </span>
                <button
                  type="button"
                  onClick={stopRecording}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-red-500/20 px-3 py-1.5 text-sm font-semibold text-red-200"
                >
                  <Icon name="stop" className="w-4 h-4" />
                  Stop
                </button>
              </div>
            )}
            {recState === 'done' && voiceNote && (
              <div className="rounded-xl border border-ink-600 bg-ink-800 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted">
                    Voice note · {fmt(voiceNote.durationSec)}
                  </span>
                  <button
                    type="button"
                    onClick={removeVoiceNote}
                    className="inline-flex min-h-[44px] items-center gap-1 px-1 text-xs font-semibold text-red-300 hover:text-red-200"
                  >
                    <Icon name="trash" className="w-3.5 h-3.5" />
                    Remove
                  </button>
                </div>
                <audio controls src={voiceNote.dataUrl} className="mt-2 w-full" />
              </div>
            )}
            {recError && <p className="mt-1.5 text-xs text-red-300">{recError}</p>}
          </div>

          <div className="flex gap-2 pt-1">
            <GhostButton onClick={onClose} className="flex-1">
              Cancel
            </GhostButton>
            <PrimaryButton onClick={handleSave} disabled={!title.trim()} className="flex-1">
              Save idea
            </PrimaryButton>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
