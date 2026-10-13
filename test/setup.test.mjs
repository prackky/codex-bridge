import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('setup generates a private token and preserves existing user configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-setup-test-'));
  try {
    const script = fileURLToPath(new URL('../scripts/setup.mjs', import.meta.url));
    const options = { env: { ...process.env, BRIDGE_SETUP_DIR: dir } };
    execFileSync(process.execPath, [script], options);
    const path = join(dir, '.env');
    const first = await readFile(path, 'utf8');
    assert.match(first, /^BRIDGE_TOKEN=[0-9a-f]{64}$/m);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    execFileSync(process.execPath, [script], options);
    assert.equal(await readFile(path, 'utf8'), first);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
