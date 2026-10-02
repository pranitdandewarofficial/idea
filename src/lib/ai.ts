/** Minimal OpenAI-compatible chat completions client with timeout + error handling. */

export class AIError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AIError';
    this.status = status;
  }
}

export interface ChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  timeoutMs?: number;
  temperature?: number;
}

export async function chatCompletion(opts: ChatOptions): Promise<string> {
  const { baseUrl, apiKey, model, system, user } = opts;
  const timeoutMs = opts.timeoutMs ?? 60000;
  const temperature = opts.temperature ?? 0.7;

  if (!baseUrl) throw new AIError('No API base URL configured. Pick a provider or enter a custom base URL in Settings.');
  if (!apiKey) throw new AIError('No API key set. Add your key in Settings to use AI validation.');
  if (!model) throw new AIError('No model configured. Enter a model name in Settings.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new AIError(
      e instanceof DOMException && e.name === 'AbortError'
        ? `Request timed out after ${Math.round(timeoutMs / 1000)}s.`
        : `Network error: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: { message?: string }; message?: string };
      detail = body?.error?.message ?? body?.message ?? '';
    } catch {
      /* ignore */
    }
    const hint =
      res.status === 401
        ? ' Check your API key in Settings.'
        : res.status === 404
          ? ' Check the base URL and model name.'
          : res.status === 429
            ? ' Rate limited — wait a moment and retry.'
            : '';
    throw new AIError(
      `Provider error ${res.status}${detail ? `: ${detail}` : ''}.${hint}`,
      res.status,
    );
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new AIError('Provider returned an invalid response.');
  }
  const text = (data as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message
    ?.content;
  if (!text || !text.trim()) throw new AIError('Provider returned an empty response.');
  return text;
}
