export const PRICING_USD_PER_M_TOKENS = {
  'claude-opus':       { in: 0,    out: 0 },
  'claude-opus-t0':    { in: 15,   out: 75 },
  'claude-opus-t1':    { in: 15,   out: 75 },
  'gpt-5':             { in: 10,   out: 30 },
  'gpt-4o-mini':       { in: 0.15, out: 0.60 },
  'gpt-4o-mini-t0':    { in: 0.15, out: 0.60 },
  'gpt-4o-mini-t1':    { in: 0.15, out: 0.60 },
  'gemini-2.5-pro':    { in: 1.25, out: 10 },
  'gemini-2.5-pro-t0': { in: 1.25, out: 10 },
  'gemini-2.5-pro-t1': { in: 1.25, out: 10 },
  'gemini-2.5-flash':  { in: 0.30, out: 2.50 },
  'gemini-2.5-flash-t0': { in: 0.30, out: 2.50 },
  'gemini-2.5-flash-t1': { in: 0.30, out: 2.50 },
  'gemini-3.1-pro-preview': { in: 2.50, out: 15 },
  'gemini-3.1-pro-preview-t0': { in: 2.50, out: 15 },
  'gemini-3.1-pro-preview-t1': { in: 2.50, out: 15 },
  'llama-3.3-70b':     { in: 0,    out: 0 },
  'llama-4-maverick':  { in: 0.40, out: 1.50 },
  'llama-4-maverick-t0': { in: 0.40, out: 1.50 },
  'llama-4-maverick-t1': { in: 0.40, out: 1.50 },
  'qwen-3-next-80b':   { in: 0.80, out: 2.50 },
  'qwen-3-next-80b-t0': { in: 0.80, out: 2.50 },
  'qwen-3-next-80b-t1': { in: 0.80, out: 2.50 },
  'mistral-large':     { in: 2,    out: 6 },
  'mistral-small':     { in: 0.20, out: 0.60 }
};

export function costFor(modelSlot, usage) {
  if (!usage) return 0;
  if (usage.cost_usd_reported) return usage.cost_usd_reported;
  const p = PRICING_USD_PER_M_TOKENS[modelSlot];
  if (!p) return 0;
  const cacheWrite = (usage.cache_creation_input_tokens ?? 0) * p.in * 1.25;
  const cacheRead = (usage.cache_read_input_tokens ?? 0) * p.in * 0.1;
  return (usage.input_tokens * p.in + usage.output_tokens * p.out + cacheWrite + cacheRead) / 1e6;
}
