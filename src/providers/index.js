import { callClaudeCli } from './claudeCli.js';
import { callOpenAi } from './openai.js';
import { callGeminiVertex } from './geminiVertex.js';
import { callGroq } from './groq.js';
import { callMistral } from './mistral.js';

export function activeModels() {
  const filter = process.env.BIAS_MODEL_FILTER;
  if (!filter) return MODELS;
  return MODELS.filter((m) => m.slot.includes(filter) || m.vendor === filter);
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
    call: (prompt) => callGeminiVertex({ prompt, model: 'gemini-2.5-pro' })
  },
  {
    slot: 'gemini-2.5-flash',
    vendor: 'google',
    tier: 'cheap',
    call: (prompt) => callGeminiVertex({ prompt, model: 'gemini-2.5-flash' })
  },
  {
    slot: 'gemini-3.5-flash',
    vendor: 'google',
    tier: 'cheap',
    call: (prompt) => callGeminiVertex({ prompt, model: 'gemini-3.5-flash' })
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
