const host = process.env.BRIDGE_HOST || '127.0.0.1';
const target = host === '0.0.0.0' ? '127.0.0.1' : host;
const path = process.argv.includes('--ready') ? '/readyz' : '/healthz';
try {
  const response = await fetch(`http://${target}:${process.env.BRIDGE_PORT || 8765}${path}`, {
    headers: { Authorization: `Bearer ${process.env.BRIDGE_TOKEN || ''}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body.status !== (path === '/readyz' ? 'ready' : 'ok')) throw new Error('Unexpected health response');
  console.log(`${path}: ${body.status}`);
} catch (error) {
  console.error(`Health check failed: ${error.message}`);
  process.exitCode = 1;
}
