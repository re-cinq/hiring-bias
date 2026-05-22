const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 1024;

export async function callAnthropic({ prompt, model = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-7', temperature = 1 }) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      temperature,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }]
      }]
    })
  });

  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }

  const envelope = await res.json();
  const text = (envelope.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const u = envelope.usage ?? {};
  return {
    data: JSON.parse(extractJsonBlock(text)),
    usage: {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0
    }
  };
}

function extractJsonBlock(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const braced = text.match(/\{[\s\S]*\}/);
  return braced ? braced[0] : text;
}
