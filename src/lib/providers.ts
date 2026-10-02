/** AI provider presets (OpenAI-compatible chat completions). */

export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  keyUrl: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: '',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct',
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'together',
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    keyUrl: 'https://api.together.xyz/settings/api-keys',
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    defaultModel: '',
    keyUrl: '',
  },
];

export function getPreset(id: string): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? PROVIDER_PRESETS[3];
}

export function resolveBaseUrl(providerId: string, customBaseUrl: string): string {
  if (providerId === 'custom') return customBaseUrl.trim().replace(/\/+$/, '');
  return getPreset(providerId).baseUrl;
}

export function resolveModel(providerId: string, model: string): string {
  const m = model.trim();
  if (m) return m;
  return getPreset(providerId).defaultModel;
}


export interface GeminiModel {
  name: string;
  displayName: string;
  supportedGenerationMethods: string[];
}

export async function listGeminiModels(apiKey: string): Promise<GeminiModel[]> {
  const key = apiKey.trim();
  if (!key) throw new Error('Enter a Gemini API key first.');

  const models: GeminiModel[] = [];
  let pageToken = '';
  do {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url, {
      headers: { 'x-goog-api-key': key },
    });
    const data = (await res.json()) as {
      models?: GeminiModel[];
      nextPageToken?: string;
      error?: { message?: string };
    };
    if (!res.ok) throw new Error(data.error?.message || `Gemini models request failed (${res.status}).`);

    models.push(
      ...(data.models ?? []).filter((m) =>
        m.supportedGenerationMethods?.includes('generateContent'),
      ),
    );
    pageToken = data.nextPageToken ?? '';
  } while (pageToken);

  return models
    .map((m) => ({ ...m, name: m.name.replace(/^models\//, '') }))
    .sort((a, b) => {
      const rank = (name: string) => {
        const n = name.toLowerCase();
        if (n.includes('flash-lite')) return 0;
        if (n.includes('flash')) return 1;
        if (n.includes('pro')) return 2;
        return 3;
      };
      return rank(a.name) - rank(b.name) || a.displayName.localeCompare(b.displayName);
    });
}

export async function findWorkingGeminiModel(apiKey: string): Promise<GeminiModel> {
  const models = await listGeminiModels(apiKey);
  if (!models.length) throw new Error('No Gemini model available for text generation with this key.');

  const candidates = models.slice(0, 6);
  for (const model of candidates) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 9000);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.name)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey.trim(),
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: OK' }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 8 },
          }),
          signal: controller.signal,
        },
      );
      if (!res.ok) continue;
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim();
      if (text) return model;
    } catch {
      // Try the next advertised model.
    } finally {
      window.clearTimeout(timer);
    }
  }

  throw new Error('Gemini responded, but none of the available text models passed the connection test.');
}
