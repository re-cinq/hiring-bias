import OpenAI from 'openai';

let client;

function getClient() {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

export async function callOpenAi({ prompt, model = 'gpt-4o-mini', temperature = 0.7 }) {
  const response = await getClient().chat.completions.create({
    model,
    temperature,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' }
  });
  return {
    data: JSON.parse(response.choices[0].message.content),
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0
    }
  };
}
