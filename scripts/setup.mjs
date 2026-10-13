import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const path = process.env.BRIDGE_SETUP_DIR ? `${process.env.BRIDGE_SETUP_DIR}/.env` : new URL('../.env', import.meta.url);
const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
try {
  await writeFile(path, template.replace('replace-with-your-gateway-key', randomBytes(32).toString('hex')), { flag: 'wx', mode: 0o600 });
  console.log('Created .env with a random gateway token. Use BRIDGE_TOKEN as your client API key.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env already exists; left unchanged.');
}
