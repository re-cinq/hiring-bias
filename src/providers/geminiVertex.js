import { VertexAI } from '@google-cloud/vertexai';

let vertex;

function getVertex() {
  if (!vertex) {
    vertex = new VertexAI({
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
    });
  }
  return vertex;
}

export async function callGeminiVertex({ prompt, model = 'gemini-2.5-pro', temperature = 0.7 }) {
  const generativeModel = getVertex().getGenerativeModel({
    model,
    generationConfig: {
      temperature,
      responseMimeType: 'application/json'
    }
  });
  const result = await generativeModel.generateContent(prompt);
  const text = result.response.candidates[0].content.parts[0].text;
  return JSON.parse(text);
}
