import { callClaudeCli } from './claudeCli.js';
import { callAnthropic } from './anthropic.js';
import { callOpenAi } from './openai.js';
import { callGemini } from './gemini.js';
import { callGroq } from './groq.js';
import { callMistral } from './mistral.js';
import { callVertexOpenAI } from './vertexOpenAI.js';

export function activeModels() {
  const filter = process.env.BIAS_MODEL_FILTER;
  if (!filter) return MODELS;
  const tokens = filter.split(',').map((s) => s.trim()).filter(Boolean);
  return MODELS.filter((m) => tokens.some((t) => m.slot.includes(t) || m.vendor === t));
}

// `call(prompt, options)` forwards options straight to the provider adapter, so callers
// that need a non-default temperature can ask for one. Omitting options leaves every
// adapter on its own default of 0.7, which is what the v1 experiments ran at.
// The Claude slots go through the CLI, which exposes no sampling controls at all —
// supportsTemperature marks that so callers can skip duplicate arms instead of paying
// twice for identical work.
export const MODELS = [
  {
    slot: 'claude-opus',
    vendor: 'anthropic',
    tier: 'flagship',
    supportsTemperature: false,
    call: (prompt) => callClaudeCli({ prompt, model: 'opus' })
  },
  {
    slot: 'claude-sonnet',
    vendor: 'anthropic',
    tier: 'flagship',
    supportsTemperature: false,
    call: (prompt) => callClaudeCli({ prompt, model: 'sonnet' })
  },
  {
    slot: 'claude-haiku',
    vendor: 'anthropic',
    tier: 'cheap',
    supportsTemperature: false,
    call: (prompt) => callClaudeCli({ prompt, model: 'haiku' })
  },
  {
    slot: 'claude-fable-5',
    vendor: 'anthropic',
    tier: 'flagship',
    supportsTemperature: false,
    call: (prompt) => callClaudeCli({ prompt, model: 'claude-fable-5' })
  },
  {
    slot: 'gpt-5',
    vendor: 'openai',
    tier: 'flagship',
    call: (prompt, options) => callOpenAi({ prompt, model: 'gpt-5', ...options })
  },
  {
    slot: 'gpt-4o-mini',
    vendor: 'openai',
    tier: 'cheap',
    call: (prompt, options) => callOpenAi({ prompt, model: 'gpt-4o-mini', ...options })
  },
  {
    slot: 'gemini-2.5-pro',
    vendor: 'google',
    tier: 'flagship',
    call: (prompt, options) => callGemini({ prompt, model: 'gemini-2.5-pro', ...options })
  },
  {
    slot: 'gemini-2.5-flash',
    vendor: 'google',
    tier: 'cheap',
    call: (prompt, options) => callGemini({ prompt, model: 'gemini-2.5-flash', ...options })
  },
  {
    slot: 'gemini-3.1-pro-preview',
    vendor: 'google',
    tier: 'flagship',
    call: (prompt, options) => callGemini({ prompt, model: 'gemini-3.1-pro-preview', location: 'global', ...options })
  },
  {
    slot: 'llama-4-maverick',
    vendor: 'meta',
    tier: 'flagship',
    call: (prompt, options) => callVertexOpenAI({ prompt, model: 'meta/llama-4-maverick-17b-128e-instruct-maas', location: 'us-east5', ...options })
  },
  {
    slot: 'qwen-3-next-80b',
    vendor: 'alibaba',
    tier: 'flagship',
    call: (prompt, options) => callVertexOpenAI({ prompt, model: 'qwen/qwen3-next-80b-a3b-instruct-maas', location: 'global', ...options })
  },
  {
    slot: 'llama-3.3-70b',
    vendor: 'meta',
    tier: 'flagship',
    call: (prompt, options) => callGroq({ prompt, model: 'llama-3.3-70b-versatile', ...options })
  },
  {
    slot: 'mistral-large',
    vendor: 'mistral',
    tier: 'flagship',
    call: (prompt, options) => callMistral({ prompt, model: 'mistral-large-latest', ...options })
  },
  {
    slot: 'mistral-small',
    vendor: 'mistral',
    tier: 'cheap',
    call: (prompt, options) => callMistral({ prompt, model: 'mistral-small-latest', ...options })
  }
];
