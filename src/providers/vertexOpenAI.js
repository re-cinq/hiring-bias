import OpenAI from 'openai';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const { stdout } = await execFileAsync('gcloud', ['auth', 'application-default', 'print-access-token']);
  cachedToken = stdout.trim();
  tokenExpiry = Date.now() + 50 * 60 * 1000;
  return cachedToken;
}

function buildBaseUrl(project, location) {
  if (location === 'global') {
    return `https://aiplatform.googleapis.com/v1beta1/projects/${project}/locations/global/endpoints/openapi`;
  }
  return `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${project}/locations/${location}/endpoints/openapi`;
}

export async function callVertexOpenAI({ prompt, model, location = 'us-central1', temperature = 0.7 }) {
  const token = await getAccessToken();
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const client = new OpenAI({ apiKey: token, baseURL: buildBaseUrl(project, location) });

  const response = await client.chat.completions.create({
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
