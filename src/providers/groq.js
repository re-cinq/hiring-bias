import OpenAI from 'openai';

let client;

function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: 'https://api.groq.com/openai/v1'
    });
  }
  return client;
}

export async function callGroq({ prompt, model = 'llama-3.3-70b-versatile', temperature = 0.7 }) {
  const response = await getClient().chat.completions.create({
    model,
    temperature,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' }
  });
  return JSON.parse(response.choices[0].message.content);
}
