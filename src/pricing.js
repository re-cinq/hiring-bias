export const PRICING_USD_PER_M_TOKENS = {
  'claude-opus':       { in: 0,    out: 0 },
  'gpt-5':             { in: 10,   out: 30 },
  'gpt-4o-mini':       { in: 0.15, out: 0.60 },
  'gemini-2.5-pro':    { in: 1.25, out: 10 },
  'gemini-2.5-flash':  { in: 0.30, out: 2.50 },
  'gemini-3.5-flash':  { in: 0.35, out: 3 },
  'llama-3.3-70b':     { in: 0,    out: 0 },
  'mistral-large':     { in: 2,    out: 6 },
  'mistral-small':     { in: 0.20, out: 0.60 }
};

export function costFor(modelSlot, usage) {
  if (!usage) return 0;
  if (usage.cost_usd_reported) return usage.cost_usd_reported;
  const p = PRICING_USD_PER_M_TOKENS[modelSlot];
  if (!p) return 0;
  return (usage.input_tokens * p.in + usage.output_tokens * p.out) / 1e6;
}
