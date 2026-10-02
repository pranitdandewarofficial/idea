/** Settings: AI provider/key/model/tone, test connection, data export/import/clear. */

import { useRef, useState } from 'react';
import type { AISettings, AppState, Tone } from '../lib/types';
import { AIError, chatCompletion } from '../lib/ai';
import { PROVIDER_PRESETS, getPreset, listGeminiModels, resolveBaseUrl, resolveModel } from '../lib/providers';
import { estimateStorageBytes } from '../lib/store';
import { ErrorBanner, Field, GhostButton, Icon, SelectWrap, Spinner, inputClass, selectClass } from './ui';

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
  onImportRaw: (raw: string) => void; // throws on invalid backup
  onClear: () => void;
}) {
  const preset = getPreset(state.settings.providerId);
  const [showKey, setShowKey] = useState(false);
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testMsg, setTestMsg] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [geminiModels, setGeminiModels] = useState<{ name: string; displayName: string }[]>([]);
  const [modelsState, setModelsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [modelsMsg, setModelsMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const callParams = () => ({
    baseUrl: resolveBaseUrl(state.settings.providerId, state.settings.customBaseUrl),
    apiKey: state.settings.apiKey.trim(),
    model: resolveModel(state.settings.providerId, state.settings.model),
    providerId: state.settings.providerId,
  });

  const loadGeminiModels = async () => {
    setModelsState('loading');
    setModelsMsg('');
    try {
      const models = await listGeminiModels(state.settings.apiKey);
      setGeminiModels(models);
      setModelsState('ready');
      setModelsMsg(models.length ? `${models.length} models available for this key.` : 'No generateContent models available.');
      if (models.length && (!state.settings.model || !models.some((m) => m.name === state.settings.model))) {
        onSettings({ model: models[0].name });
      }
    } catch (e) {
      setModelsState('error');
      setModelsMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const testConnection = async () => {
    setTestState('testing');
    setTestMsg('');
    try {
      await chatCompletion({
        ...callParams(),
        system: 'You are a connectivity test.',
        user: 'Reply with: ok',
        timeoutMs: 20000,
        temperature: 0,
      });
      setTestState('ok');
      setTestMsg('Connection OK — provider responded.');
    } catch (e) {
      setTestState('fail');
      setTestMsg(e instanceof AIError ? e.message : `Test failed: ${String(e)}`);
    }
  };

  const handleFile = async (f: File) => {
    setImportError(null);
    try {
      const raw = await f.text();
      onImportRaw(raw);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Import failed.');
    }
  };

  const handleClear = () => {
    if (window.confirm('Clear ALL data? Every idea, validation, roadmap and setting will be wiped.')) {
      onClear();
    }
  };

  const toneBtn = (tone: Tone, label: string, hint: string) => (
    <button
      key={tone}
      type="button"
      onClick={() => onSettings({ tone })}
      className={`flex-1 rounded-xl border p-3 text-left transition ${
        state.settings.tone === tone
          ? 'border-gold-400/60 bg-gold-400/10'
          : 'border-ink-600 bg-ink-800'
      }`}
    >
      <span className={`block text-sm font-bold ${state.settings.tone === tone ? 'text-gold-400' : 'text-ivory'}`}>
        {label}
      </span>
      <span className="mt-0.5 block text-xs text-muted">{hint}</span>
    </button>
  );

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-3 text-base font-bold text-ivory">AI provider</h2>
        <div className="space-y-4 rounded-2xl border border-ink-700 bg-ink-900 p-4">
          <Field label="Provider">
            <SelectWrap>
              <select
                value={state.settings.providerId}
                onChange={(e) => onSettings({ providerId: e.target.value })}
                className={selectClass}
              >
                {PROVIDER_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </SelectWrap>
          </Field>
          {preset.keyUrl && (
            <a
              href={preset.keyUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold text-gold-400 hover:text-gold-300"
            >
              <Icon name="key" className="w-4 h-4" />
              Get a {preset.name} key
            </a>
          )}
          {state.settings.providerId === 'custom' && (
            <Field label="Custom base URL" hint="OpenAI-compatible, e.g. https://your-host/v1">
              <input
                className={inputClass}
                value={state.settings.customBaseUrl}
                onChange={(e) => onSettings({ customBaseUrl: e.target.value })}
                placeholder="https://your-host/v1"
                inputMode="url"
              />
            </Field>
          )}
          <Field label="API key">
            <div className="relative">
              <input
                className={`${inputClass} pr-11`}
                type={showKey ? 'text' : 'password'}
                value={state.settings.apiKey}
                onChange={(e) => onSettings({ apiKey: e.target.value })}
                placeholder="Paste your key"
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowKey((s) => !s)}
                aria-label={showKey ? 'Hide key' : 'Show key'}
                className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-muted hover:text-ivory"
              >
                <Icon name={showKey ? 'eyeOff' : 'eye'} className="w-4 h-4" />
              </button>
            </div>
          </Field>
          <Field label="Model" hint={state.settings.providerId === 'gemini' ? 'Fetched from Google for your API key' : `Default: ${preset.defaultModel || '—'}`}>
            {state.settings.providerId === 'gemini' ? (
              <div className="space-y-2">
                <SelectWrap>
                  <select value={state.settings.model} onChange={(e) => onSettings({ model: e.target.value })} className={selectClass} disabled={modelsState === 'loading'}>
                    {!geminiModels.length && <option value="">Fetch available models first</option>}
                    {geminiModels.map((m) => <option key={m.name} value={m.name}>{m.displayName} · {m.name}</option>)}
                  </select>
                </SelectWrap>
                <GhostButton onClick={loadGeminiModels} disabled={!state.settings.apiKey.trim() || modelsState === 'loading'} className="w-full">
                  {modelsState === 'loading' ? <Spinner className="w-4 h-4" /> : <Icon name="refresh" className="w-4 h-4" />}
                  {modelsState === 'loading' ? 'Fetching models…' : 'Fetch available Gemini models'}
                </GhostButton>
                {modelsMsg && <p className="text-xs text-muted">{modelsMsg}</p>}
              </div>
            ) : (
              <input className={inputClass} value={state.settings.model} onChange={(e) => onSettings({ model: e.target.value })} placeholder={preset.defaultModel || 'model-name'} autoComplete="off" />
            )}
          </Field>
          <div>
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted">
              AI tone
            </span>
            <div className="flex gap-2">
              {toneBtn('professional', 'Professional', 'Crisp, direct, first-principles')}
              {toneBtn('hinglish', 'Hinglish', 'Bhai-style, seedhi baat, desi founder energy')}
            </div>
          </div>
          <div>
            <GhostButton onClick={testConnection} disabled={testState === 'testing'} className="w-full">
              {testState === 'testing' ? <Spinner className="w-4 h-4" /> : <Icon name="activity" className="w-4 h-4" />}
              {testState === 'testing' ? 'Testing…' : 'Test connection'}
            </GhostButton>
            {testState === 'ok' && (
              <p className="mt-2 flex items-center gap-1.5 text-sm text-emerald-300">
                <Icon name="check" className="w-4 h-4" />
                {testMsg}
              </p>
            )}
            {testState === 'fail' && (
              <p className="mt-2 flex items-start gap-1.5 text-sm text-red-300">
                <Icon name="alert" className="w-4 h-4 shrink-0 mt-0.5" />
                {testMsg}
              </p>
            )}
          </div>
          <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted">
            <Icon name="shield" className="mt-0.5 w-3.5 h-3.5 shrink-0" />
            Your API key is stored only in this browser's localStorage and is sent only to the
            provider you chose. Nothing else leaves your device.
          </p>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-base font-bold text-ivory">Data</h2>
        <div className="space-y-3 rounded-2xl border border-ink-700 bg-ink-900 p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="inline-flex items-center gap-1.5 text-muted">
              <Icon name="database" className="w-4 h-4" />
              Storage used
            </span>
            <span className="font-bold text-ivory">{formatBytes(estimateStorageBytes(state))}</span>
          </div>
          <div className="flex gap-2">
            <GhostButton onClick={onExport} className="flex-1">
              <Icon name="download" className="w-4 h-4" />
              Export backup
            </GhostButton>
            <GhostButton onClick={() => fileRef.current?.click()} className="flex-1">
              <Icon name="upload" className="w-4 h-4" />
              Import backup
            </GhostButton>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void handleFile(f);
              }}
            />
          </div>
          {importError && <ErrorBanner message={importError} onDismiss={() => setImportError(null)} />}
          <div className="border-t border-ink-700 pt-3">
            <button
              type="button"
              onClick={handleClear}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm font-semibold text-red-300 transition active:scale-[0.98]"
            >
              <Icon name="trash" className="w-4 h-4" />
              Clear all data
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
