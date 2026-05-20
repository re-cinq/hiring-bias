import { GoogleGenAI } from '@google/genai';

const clients = new Map();

function getClient(location) {
  const loc = location ?? process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1';
  if (clients.has(loc)) return clients.get(loc);
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const c = project
    ? new GoogleGenAI({ vertexai: true, project, location: loc })
    : new GoogleGenAI({ apiKey: process.env.GOOGLE_GENAI_API_KEY });
  clients.set(loc, c);
  return c;
}

export async function callGemini({ prompt, model = 'gemini-2.5-flash', temperature = 0.7, location }) {
  const response = await getClient(location).models.generateContent({
    model,
    contents: prompt,
    config: {
      temperature,
      responseMimeType: 'application/json'
    }
  });
  const u = response.usageMetadata ?? {};
  return {
    data: JSON.parse(response.text),
    usage: {
      input_tokens: u.promptTokenCount ?? 0,
      output_tokens: u.candidatesTokenCount ?? 0
    }
  };
}
