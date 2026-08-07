import { spawn } from 'node:child_process';

const MAX_BUFFER = 10 * 1024 * 1024;

// stdin: 'ignore' hands claude an immediate EOF — otherwise the CLI waits ~3s per call
// for stdin that never comes ("no stdin data received in 3s, proceeding without it").
function runClaude(args) {
  // Run the claude CLI under its own session login (subscription), not a metered API key.
  // `npm run` loads dotenv, which puts ANTHROPIC_API_KEY in the env; if the CLI sees it,
  // it bills the API credit balance ("Credit balance is too low") instead of the CLI session.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      if (stdout.length > MAX_BUFFER) { child.kill(); reject(new Error('claude stdout exceeded maxBuffer')); }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    // claude -p --output-format json writes its error payload to stdout, not stderr, so include both.
    child.on('close', (code) => code === 0
      ? resolve(stdout)
      : reject(new Error(`claude exited ${code}: ${(stderr.trim() || stdout.trim() || '(no output)').slice(0, 500)}`)));
  });
}

// Without these the CLI attaches its own operating context to every call: the Claude Code
// system prompt, the built-in tool definitions, MCP schemas and whatever CLAUDE.md it
// auto-discovers. Measured against the first 28,050 results that is ~29,000 input tokens
// per call on top of a ~2,800-token prompt, and it is context the API-called models in
// this study never see, which makes the two groups unequal on more than the model.
//
// Not `--bare`, which does the same job but forces auth to ANTHROPIC_API_KEY — exactly
// what runClaude deletes above so the call bills the CLI session instead of API credit.
//
// The empty --system-prompt is what closes the gap the rest of the flags only narrow.
// Every API provider here sends one user message and no system prompt at all, so this is
// the setting that puts the Claude slots in the same condition as the other seven models
// rather than merely a cheaper version of their own. Measured: 31,600 → 167 input tokens.
const NO_HARNESS_ARGS = [
  '--safe-mode', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--system-prompt', ''
];

export async function callClaudeCli({ prompt, model = 'opus', harnessContext = false }) {
  const args = ['-p', prompt, '--model', model, '--output-format', 'json'];
  if (!harnessContext) args.push(...NO_HARNESS_ARGS);
  const stdout = await runClaude(args);
  const envelope = JSON.parse(stdout);
  const text = envelope.result ?? envelope.message ?? '';
  const u = envelope.usage ?? {};
  return {
    data: JSON.parse(extractJsonBlock(text)),
    usage: {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      cost_usd_reported: envelope.total_cost_usd ?? 0
    }
  };
}

function extractJsonBlock(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const braced = text.match(/\{[\s\S]*\}/);
  return braced ? braced[0] : text;
}
