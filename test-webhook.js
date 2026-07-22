const fs = require('fs');
const crypto = require('crypto');

const devVars = fs.readFileSync('.dev.vars', 'utf8');
const secretLine = devVars.split('\n').find(l => l.startsWith('MP_WEBHOOK_SECRET'));
const SECRET = secretLine.split('=')[1].trim().replace(/^["']|["']$/g, '');

const PAYMENT_ID = process.argv[2];
if (!PAYMENT_ID) {
  console.error('Uso: node test-webhook.js <payment_id>');
  process.exit(1);
}

const REQUEST_ID = 'test-request-' + Date.now();
const TS = Math.floor(Date.now() / 1000).toString();
const manifest = `id:${PAYMENT_ID.toLowerCase()};request-id:${REQUEST_ID};ts:${TS};`;
const hash = crypto.createHmac('sha256', SECRET).update(manifest).digest('hex');

console.log(`curl -X POST "http://127.0.0.1:8787/api/webhooks/mercadopago?data.id=${PAYMENT_ID}&type=payment" -H "x-request-id: ${REQUEST_ID}" -H "x-signature: ts=${TS},v1=${hash}"`);
