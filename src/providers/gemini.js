import { GoogleGenAI } from '@google/genai';

let client;

function getClient() {
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GOOGLE_GENAI_API_KEY });
  return client;
}

export async function callGemini({ prompt, model = 'gemini-2.5-flash', temperature = 0.7 }) {
  const response = await getClient().models.generateContent({
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
