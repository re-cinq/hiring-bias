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

export const MODELS = [
  {
    slot: 'claude-opus',
    vendor: 'anthropic',
    tier: 'flagship',
    call: (prompt) => callClaudeCli({ prompt, model: 'opus' })
  },
  {
    slot: 'gpt-5',
    vendor: 'openai',
    tier: 'flagship',
    call: (prompt) => callOpenAi({ prompt, model: 'gpt-5' })
  },
  {
    slot: 'gpt-4o-mini',
    vendor: 'openai',
    tier: 'cheap',
    call: (prompt) => callOpenAi({ prompt, model: 'gpt-4o-mini' })
  },
  {
    slot: 'gemini-2.5-pro',
    vendor: 'google',
    tier: 'flagship',
    call: (prompt) => callGemini({ prompt, model: 'gemini-2.5-pro' })
  },
  {
    slot: 'gemini-2.5-flash',
    vendor: 'google',
    tier: 'cheap',
    call: (prompt) => callGemini({ prompt, model: 'gemini-2.5-flash' })
  },
  {
    slot: 'gemini-3.1-pro-preview',
    vendor: 'google',
    tier: 'flagship',
    call: (prompt) => callGemini({ prompt, model: 'gemini-3.1-pro-preview', location: 'global' })
  },
  {
    slot: 'llama-4-maverick',
    vendor: 'meta',
    tier: 'flagship',
    call: (prompt) => callVertexOpenAI({ prompt, model: 'meta/llama-4-maverick-17b-128e-instruct-maas', location: 'us-east5' })
  },
  {
    slot: 'qwen-3-next-80b',
    vendor: 'alibaba',
    tier: 'flagship',
    call: (prompt) => callVertexOpenAI({ prompt, model: 'qwen/qwen3-next-80b-a3b-instruct-maas', location: 'global' })
  },
  {
    slot: 'llama-3.3-70b',
    vendor: 'meta',
    tier: 'flagship',
    call: (prompt) => callGroq({ prompt, model: 'llama-3.3-70b-versatile' })
  },
  {
    slot: 'mistral-large',
    vendor: 'mistral',
    tier: 'flagship',
    call: (prompt) => callMistral({ prompt, model: 'mistral-large-latest' })
  },
  {
    slot: 'mistral-small',
    vendor: 'mistral',
    tier: 'cheap',
    call: (prompt) => callMistral({ prompt, model: 'mistral-small-latest' })
  }
];
