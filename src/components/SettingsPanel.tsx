/** Simple settings: AI connection, tone, and local data. */

import { useRef, useState } from 'react';
import type { AISettings, AppState, Tone } from '../lib/types';
import { AIError, chatCompletion } from '../lib/ai';
import { findWorkingGeminiModel } from '../lib/providers';
import { estimateStorageBytes } from '../lib/store';
import { ErrorBanner, GhostButton, Icon, PrimaryButton, Spinner, inputClass } from './ui';

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function SettingsPanel({
  state,
  onSettings,
  onExport,
  onImportRaw,
  onClear,
}: {
  state: AppState;
  onSettings: (patch: Partial<AISettings>) => void;
  onExport: () => void;
  onImportRaw: (raw: string) => void;
  onClear: () => void;
}) {
  const [editingKey, setEditingKey] = useState(false);
  const [apiKey, setApiKey] = useState(state.settings.apiKey);
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const connect = async () => {
    const key = apiKey.trim();
    if (!key) return;
    setStatus('checking');
    setMessage('');
    try {
      const model = await findWorkingGeminiModel(key);
      onSettings({ providerId: 'gemini', customBaseUrl: '', apiKey: key, model: model.name });
      setEditingKey(false);
      setStatus('ok');
      setMessage(model.displayName || model.name);
    } catch (e) {
      setStatus('error');
      setMessage(e instanceof Error ? e.message : 'Could not connect to Gemini.');
    }
  };

  const testConnection = async () => {
    setStatus('checking');
    setMessage('');
    try {
      await chatCompletion({
        providerId: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: state.settings.apiKey.trim(),
        model: state.settings.model,
        system: 'You are a connectivity test.',
        user: 'Reply with exactly: OK',
        timeoutMs: 15000,
        temperature: 0,
      });
      setStatus('ok');
      setMessage(state.settings.model);
    } catch (e) {
      setStatus('error');
      setMessage(e instanceof AIError ? e.message : String(e));
    }
  };

  const handleFile = async (f: File) => {
    setImportError(null);
    try {
      onImportRaw(await f.text());
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Import failed.');
    }
  };

  const handleClear = () => {
    if (window.confirm('Clear ALL data? Every idea, validation, roadmap and setting will be wiped.')) {
      onClear();
      localStorage.removeItem('ideaforge:onboarding:v2');
      window.location.reload();
    }
  };

  const toneButton = (tone: Tone, title: string, hint: string) => (
    <button
      type="button"
      onClick={() => onSettings({ tone })}
      className={`flex-1 rounded-xl border p-3 text-left transition $
        state.settings.tone === tone ? 'border-gold-400/60 bg-gold-400/10' : 'border-ink-600 bg-ink-800'
      }`}
    >
      <span className={`block text-sm font-bold ${state.settings.tone === tone ? 'text-gold-400' : 'text-ivory'}`}>{title}</span>
      <span className="mt-0.5 block text-xs text-muted">{hint}</span>
    </button>
  );

  return (
    <div className="animate-page-in space-y-5">
      <section className="rounded-3xl border border-ink-700 bg-ink-900 p-5 shadow-lg shadow-black/10">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gold-400/10 text-gold-400">
            <Icon name="sparkles" className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold">AI connection</h2>
              <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300">Gemini</span>
            </div>
            <p className="mt-1 text-xs text-muted">IdeaForge automatically uses a working text model. You never need to choose one.</p>
          </div>
        </div>

        {!editingKey ? (
          <div className="mt-4 rounded-2xl border border-emerald-400/20 bg-emerald-400/5 p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-400 text-ink-950">
                <Icon name="check" className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold">Connected</p>
                <p className="truncate text-xs text-muted">{state.settings.model || 'Working Gemini model'}</p>
              </div>
              <button type="button" onClick={() => { setApiKey(state.settings.apiKey); setEditingKey(true); setStatus('idle'); }} className="text-xs font-bold text-gold-400">Change</button>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="relative">
              <input
                className={`${inputClass} pr-11`}
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => { setApiKey(e.target.value); setStatus('idle'); setMessage(''); }}
                placeholder="Paste Gemini API key"
                autoComplete="off"
                autoFocus
              />
              <button type="button" onClick={() => setShowKey((v) => !v)} className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center text-muted" aria-label="Toggle API key visibility">
                <Icon name={showKey ? 'eyeOff' : 'eye'} className="h-4 w-4" />
              </button>
            </div>
            <div className="flex gap-2">
              <GhostButton onClick={() => setEditingKey(false)} className="flex-1">Cancel</GhostButton>
              <PrimaryButton onClick={connect} disabled={!apiKey.trim() || status === 'checking'} className="flex-1">
                {status === 'checking' ? <Spinner className="h-4 w-4" /> : <Icon name="refresh" className="h-4 w-4" />}
                {status === 'checking' ? 'Checking…' : 'Auto-connect'}
              </PrimaryButton>
            </div>
          </div>
        )}

        {status === 'checking' && !editingKey && (
          <p className="mt-3 flex items-center gap-2 text-xs text-muted"><Spinner className="h-3.5 w-3.5" /> Testing the saved model…</p>
        )}
        {status === 'ok' && <p className="mt-3 flex items-center gap-2 text-xs text-emerald-300"><Icon name="check" className="h-3.5 w-3.5" /> Working: {message}</p>}
        {status === 'error' && <div className="mt-3"><ErrorBanner message={message} /></div>}

        {!editingKey && (
          <GhostButton onClick={testConnection} disabled={status === 'checking'} className="mt-3 w-full">
            {status === 'checking' ? <Spinner className="h-4 w-4" /> : <Icon name="activity" className="h-4 w-4" />}
            {status === 'checking' ? 'Testing…' : 'Test connection'}
          </GhostButton>
        )}

        <p className="mt-3 text-[11px] leading-5 text-muted">Your key stays in this app's local storage and is sent directly to Google for Gemini requests.</p>
      </section>

      <section className="rounded-3xl border border-ink-700 bg-ink-900 p-5">
        <h2 className="text-base font-bold">Response style</h2>
        <p className="mt-1 text-xs text-muted">How IdeaForge talks when generating validation and roadmaps.</p>
        <div className="mt-3 flex gap-2">
          {toneButton('professional', 'Professional', 'Crisp and direct')}
          {toneButton('hinglish', 'Hinglish', 'Founder-style')}
        </div>
      </section>

      <section className="rounded-3xl border border-ink-700 bg-ink-900 p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold">Your data</h2>
            <p className="mt-1 text-xs text-muted">Stored locally on this device.</p>
          </div>
          <span className="text-xs font-semibold text-muted">{formatBytes(estimateStorageBytes(state))}</span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <GhostButton onClick={onExport} className="w-full"><Icon name="download" className="h-4 w-4" />Export</GhostButton>
          <GhostButton onClick={() => fileRef.current?.click()} className="w-full"><Icon name="upload" className="h-4 w-4" />Import</GhostButton>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f=e.target.files?.[0]; e.target.value=''; if(f) void handleFile(f); }} />
        </div>
        {importError && <div className="mt-3"><ErrorBanner message={importError} onDismiss={() => setImportError(null)} /></div>}
        <button type="button" onClick={handleClear} className="mt-4 inline-flex min-h-11 items-center gap-2 text-xs font-semibold text-red-300"><Icon name="trash" className="h-4 w-4" />Clear all data</button>
      </section>
    </div>
  );
}
