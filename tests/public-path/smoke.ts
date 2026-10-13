import { startPublicPath } from './harness';
(async () => {
  const path = await startPublicPath();
  const res = await fetch(path.chatStreamUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...path.customerHeaders }, body: JSON.stringify({ message: 'vanities', sessionId: 'smoke-1' }) });
  console.log(res.status, res.headers.get('content-type'));
  console.log((await res.text()).slice(0, 1500));
  await path.stop();
  process.exit(0);
})().catch((error) => { console.error('FAILED', error); process.exit(1); });
