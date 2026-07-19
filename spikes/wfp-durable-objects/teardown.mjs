/**
 * Delete what the spike created. A spike that cannot be removed becomes
 * infrastructure by accident.
 *
 * Run: node teardown.mjs   (then `cd dispatcher && pnpm run delete`)
 */

const {
  CF_ACCOUNT_ID,
  CF_API_TOKEN,
  WFP_NAMESPACE = 'substrat-spike',
  WFP_SCRIPT = 'spike-vertical',
} = process.env;

if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
  console.error('Set CF_ACCOUNT_ID and CF_API_TOKEN.');
  process.exit(2);
}

const api = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}`;
const auth = { Authorization: `Bearer ${CF_API_TOKEN}` };

for (const [label, path] of [
  [`script ${WFP_SCRIPT}`, `/workers/dispatch/namespaces/${WFP_NAMESPACE}/scripts/${WFP_SCRIPT}`],
  [`namespace ${WFP_NAMESPACE}`, `/workers/dispatch/namespaces/${WFP_NAMESPACE}`],
]) {
  const res = await fetch(`${api}${path}`, { method: 'DELETE', headers: auth });
  console.log(`${res.ok ? '✓ deleted' : `· skipped (HTTP ${res.status})`} ${label}`);
}

console.log('\nThe dispatcher is a normal worker: cd dispatcher && pnpm run delete');
