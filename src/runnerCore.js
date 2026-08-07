import fs from 'node:fs/promises';
import path from 'node:path';

export async function loadMarkdownFiles(dir) {
  const entries = await fs.readdir(dir);
  const out = [];
  for (const file of entries) {
    if (!file.endsWith('.md')) continue;
    const content = await fs.readFile(path.join(dir, file), 'utf8');
    out.push({ name: path.basename(file, '.md'), content });
  }
  return out;
}

export async function fileExists(p) {
  return fs.access(p).then(() => true, () => false);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Billing/auth failures will never succeed on retry — fail immediately instead of hammering.
export function isFatal(err) {
  const m = (err?.message ?? '').toLowerCase();
  return m.includes('credit balance is too low')         // anthropic api
    || m.includes('api_error_status":400')               // anthropic 400 envelope
    || (m.includes('api_error_status":429') && m.includes("hit your limit"))  // claude CLI subscription cap (resets later)
    || m.includes('exceeded your current quota')         // openai 429 (quota exhausted, not rate limit)
    || m.includes('insufficient_quota')                  // openai error code
    || m.includes('invalid_grant') || m.includes('invalid_rapt')  // google cloud / vertex reauth
    || m.includes('billing details')                     // generic billing hint
    || m.includes('401') || m.includes('403')
    || m.includes('authentication')
    // Claude CLI rejected the call before reaching the API — zero duration, zero tokens,
    // zero cost. That is a usage cap, not a transient blip, so retrying just burns
    // backoff on every remaining call in the run.
    || (m.includes('"is_error":true') && m.includes('"duration_api_ms":0') && m.includes('"total_cost_usd":0'));
}

// Hitting a per-minute rate limit (Mistral, OpenAI, etc.) only clears when the window rolls,
// so back off long enough to clear it — a 2s retry just wastes the next attempt on the same limit.
export function backoffMs(err, attempt) {
  const m = (err?.message ?? '').toLowerCase();
  const is429 = m.includes('429') || m.includes('rate_limited') || m.includes('rate limit');
  return is429 ? 30000 * (attempt + 1) : 1500 * (attempt + 1);
}

// Retry transient provider failures — rate limits, overload, truncated/malformed JSON.
// `options` is forwarded to the provider adapter (temperature, and anything else a
// caller needs to override); omitting it keeps every adapter on its own defaults.
export async function callWithRetry(model, prompt, retries = 2, options) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await model.call(prompt, options);
    } catch (err) {
      lastErr = err;
      if (isFatal(err) || attempt === retries) break;
      await sleep(backoffMs(err, attempt));
    }
  }
  throw lastErr;
}
