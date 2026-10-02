import { useEffect, useState } from 'react';
import { findWorkingGeminiModel } from '../lib/providers';
import type { AISettings } from '../lib/types';
import { ErrorBanner, Icon, PrimaryButton, Spinner, inputClass } from './ui';

const SETUP_KEY = 'ideaforge:onboarding:v2';

export function hasCompletedOnboarding(): boolean {
  try {
    return localStorage.getItem(SETUP_KEY) === '1';
  } catch {
    return false;
  }
}

export function SetupScreen({
  initialSettings,
  onComplete,
}: {
  initialSettings: AISettings;
  onComplete: (patch: Partial<AISettings>) => void;
}) {
  const [apiKey, setApiKey] = useState(initialSettings.apiKey);
  const [status, setStatus] = useState<'idle' | 'checking' | 'success' | 'error'>('idle');
  const [modelName, setModelName] = useState('');
  const [message, setMessage] = useState('');
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    setApiKey(initialSettings.apiKey);
  }, [initialSettings.apiKey]);

  const connect = async () => {
    const key = apiKey.trim();
    if (!key) return;

    setStatus('checking');
    setMessage('');
    setModelName('');

    try {
      const model = await findWorkingGeminiModel(key);
      onComplete({
        providerId: 'gemini',
        customBaseUrl: '',
        apiKey: key,
        model: model.name,
      });
      localStorage.setItem(SETUP_KEY, '1');
      setModelName(model.displayName || model.name);
      setStatus('success');
      setMessage('AI is ready. Opening your workspace…');
    } catch (e) {
      setStatus('error');
      setMessage(e instanceof Error ? e.message : 'Could not connect to Gemini.');
    }
  };

  return (
    <main className="min-h-dvh bg-ink-950 px-5 py-8 text-ivory">
      <div className="mx-auto flex min-h-[calc(100dvh-4rem)] max-w-md flex-col justify-center">
        <div className="setup-card animate-page-in rounded-[2rem] border border-ink-700 bg-ink-900/90 p-6 shadow-2xl shadow-black/30 sm:p-8">
          <div className="mb-8">
            <div className="mb-6 flex h-14 w-14 animate-float items-center justify-center rounded-2xl bg-gold-400 text-ink-950 shadow-lg shadow-gold-400/20">
              <Icon name="sparkles" className="h-7 w-7" />
            </div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-gold-400">IdeaForge</p>
            <h1 className="mt-2 text-3xl font-black tracking-tight">Turn ideas into action.</h1>
            <p className="mt-3 text-sm leading-6 text-muted">
              One quick setup. IdeaForge will find a Gemini model that actually works with your key and select it for you.
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="mb-2 block text-sm font-bold text-ivory">Gemini API key</label>
              <div className="relative">
                <input
                  className={`${inputClass} pr-12`}
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setStatus('idle');
                    setMessage('');
                  }}
                  placeholder="Paste your Gemini API key"
                  autoComplete="off"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:text-ivory"
                  aria-label={showKey ? 'Hide API key' : 'Show API key'}
                >
                  <Icon name={showKey ? 'eyeOff' : 'eye'} className="h-4 w-4" />
                </button>
              </div>
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-gold-400"
              >
                Get a Gemini API key <Icon name="chevronRight" className="h-3.5 w-3.5" />
              </a>
            </div>

            <div className="rounded-2xl border border-ink-700 bg-ink-800/70 p-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-400/10 text-emerald-300">
                  <Icon name="shield" className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-bold">You choose the key. We do the rest.</p>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    We check the models available to this key, test a few suitable text models, then automatically use the first one that responds.
                  </p>
                </div>
              </div>
            </div>

            {status === 'checking' && (
              <div className="animate-page-in rounded-2xl border border-gold-400/20 bg-gold-400/5 p-4">
                <div className="flex items-center gap-3">
                  <Spinner className="h-5 w-5 text-gold-400" />
                  <div>
                    <p className="text-sm font-bold">Connecting to Gemini…</p>
                    <p className="mt-0.5 text-xs text-muted">Finding a model and testing it automatically.</p>
                  </div>
                </div>
              </div>
            )}

            {status === 'success' && (
              <div className="animate-page-in rounded-2xl border border-emerald-400/30 bg-emerald-400/10 p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-400 text-ink-950">
                    <Icon name="check" className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm font-bold">Connected</p>
                    <p className="mt-0.5 text-xs text-muted">{modelName}</p>
                  </div>
                </div>
              </div>
            )}

            {status === 'error' && <ErrorBanner message={message} />}

            <PrimaryButton
              onClick={connect}
              disabled={!apiKey.trim() || status === 'checking' || status === 'success'}
              className="w-full min-h-12 rounded-2xl"
            >
              {status === 'checking' ? <Spinner /> : <Icon name="sparkles" className="h-4 w-4" />}
              {status === 'checking' ? 'Setting things up…' : status === 'success' ? 'Ready' : 'Connect & continue'}
            </PrimaryButton>
          </div>

          <p className="mt-6 text-center text-[11px] leading-5 text-muted/70">
            Your key stays on this device and is sent directly to Google for Gemini requests.
          </p>
        </div>
      </div>
    </main>
  );
}
