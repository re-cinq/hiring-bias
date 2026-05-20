import { Mistral } from '@mistralai/mistralai';

let client;

function getClient() {
  if (!client) client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
  return client;
}

export async function callMistral({ prompt, model = 'mistral-small-latest', temperature = 0.7 }) {
  const response = await getClient().chat.complete({
    model,
    temperature,
    messages: [{ role: 'user', content: prompt }],
    responseFormat: { type: 'json_object' }
  });
  return JSON.parse(response.choices[0].message.content);
}
