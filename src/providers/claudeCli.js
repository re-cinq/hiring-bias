import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;

export async function callClaudeCli({ prompt, model = 'opus' }) {
  const { stdout } = await execFileAsync(
    'claude',
    ['-p', prompt, '--model', model, '--output-format', 'json'],
    { maxBuffer: MAX_BUFFER }
  );
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
