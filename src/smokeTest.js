import 'dotenv/config';
import { activeModels } from './providers/index.js';

const TEST_PROMPT = 'Respond with a JSON object exactly like this and nothing else: {"ok": true, "model_self_label": "<your model name>"}';

for (const model of activeModels()) {
  process.stdout.write(`${model.slot.padEnd(20)} `);
  try {
    const { data, usage } = await model.call(TEST_PROMPT);
    const tokens = `${usage.input_tokens}in/${usage.output_tokens}out`;
    console.log(`OK   ${tokens.padEnd(14)} ${JSON.stringify(data).slice(0, 80)}`);
  } catch (err) {
    console.log('FAIL', (err.message ?? String(err)).slice(0, 200));
  }
}
