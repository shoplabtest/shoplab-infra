// End-to-end smoke test against the running Compose stack: seed, log in, create a product, shop as a guest, merge, check out.
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const IAM = process.env.IAM_URL ?? 'http://localhost:3001';
const CATALOG = process.env.CATALOG_URL ?? 'http://localhost:3002';
const CART = process.env.CART_URL ?? 'http://localhost:3003';
const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? 'dev-only-webhook-secret';
const ADMIN = { email: 'grace.rossi.0@shoplab.test', password: 'password123' }; // first user from iam's seed

const compose = (...args) => execFileSync('docker', ['compose', ...args], { stdio: 'inherit' });

async function waitFor(url, label) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${url}/healthz`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label} never became healthy`);
}

async function call(base, path, { method = 'GET', body, token, cartId } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...(cartId && { 'x-cart-id': cartId }) },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function expect(cond, msg) {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
  console.log(`ok  ${msg}`);
}

if (!process.env.SKIP_SEED) {
  compose('exec', '-T', 'iam', 'node', 'dist/seed.js');
  compose('exec', '-T', 'catalog-api', 'node', 'dist/seed.js');
  compose('exec', '-T', 'cart-api', 'node', 'dist/seed.js');
  compose('exec', '-T', 'orders', 'node', 'dist/seed.js');
  compose('exec', '-T', 'payments', 'python', '-m', 'app.seed');
  compose('exec', '-T', 'invoices', 'node', 'dist/seed.js');
  compose('exec', '-T', 'notifications', 'node', 'dist/seed.js');
}
await Promise.all([waitFor(IAM, 'iam'), waitFor(CATALOG, 'catalog-api'), waitFor(CART, 'cart-api'), waitFor(GATEWAY, 'gateway')]);

const admin = await call(IAM, '/auth/login', { method: 'POST', body: ADMIN });
expect(admin.status === 200, 'seeded admin can log in');

const list = await call(CATALOG, '/products?category=audio');
expect(list.status === 200 && list.body.length > 0, 'seeded catalog lists products');

const created = await call(CATALOG, '/products', {
  method: 'POST', token: admin.body.accessToken,
  body: { name: `Smoke Speaker ${Date.now()}`, price: { amount: 4200, currency: 'USD' }, categoryId: 'audio' },
});
expect(created.status === 201, 'admin token from iam is accepted by catalog-api');

const guest = await call(CART, '/cart/items', { method: 'POST', body: { productId: created.body.id, quantity: 2 } });
expect(guest.status === 200 && guest.body.total === 8400, 'guest adds a product; price snapshot comes from catalog-api');

const email = `smoke.${Date.now()}@shoplab.test`;
expect((await call(IAM, '/auth/register', { method: 'POST', body: { email, password: 'password123', fullName: 'Smoke Test' } })).status === 201, 'new user registers');
const user = await call(IAM, '/auth/login', { method: 'POST', body: { email, password: 'password123' } });
const merged = await call(CART, '/cart/merge', { method: 'POST', token: user.body.accessToken, body: { guestCartId: guest.body.id } });
expect(merged.status === 200 && merged.body.lines[0]?.quantity === 2, 'guest cart merges into the user cart on login');

const coupon = await call(CART, '/cart/coupon', { method: 'POST', token: user.body.accessToken, body: { code: 'WELCOME10' } });
expect(coupon.body.total === 7560, 'coupon takes 10% off');

const checkout = await call(CART, '/cart/checkout', { method: 'POST', token: user.body.accessToken });
expect(checkout.status === 202, 'checkout is accepted');
// --- Phase 2: orders, payments, invoices and notifications, all through the gateway ---------------------------------

/** Retries `probe` until it returns something other than undefined. Checkout is event driven, so results arrive a moment later. */
async function eventually(label, probe, seconds = 30) {
  for (let i = 0; i < seconds * 2; i++) {
    const found = await probe();
    if (found !== undefined) return found;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`smoke failed: ${label} never happened`);
}

/** The provider calls the webhook with a hex HMAC-SHA256 of the exact request body. */
async function webhook(paymentId, outcome, secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify({ paymentId, outcome, ...(outcome === 'failed' && { reason: 'card_declined' }) });
  const res = await fetch(`${GATEWAY}/payments/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-provider-signature': createHmac('sha256', secret).update(raw).digest('hex') },
    body: raw,
  });
  return res.status;
}

const ready = await call(GATEWAY, '/readyz');
expect(ready.status === 200 && Object.values(ready.body.upstreams).every((s) => s === 'up'), 'gateway reports every upstream up');
expect((await call(GATEWAY, '/orders')).status === 401, 'gateway refuses /orders without a token');
expect((await call(GATEWAY, '/invoices', { token: user.body.accessToken })).status === 403, 'gateway keeps customers out of /invoices');

const orderFor = (token, cartId) => eventually('order for the checked-out cart', async () => (await call(GATEWAY, '/orders', { token })).body.find((o) => o.cartId === cartId));
const order = await orderFor(user.body.accessToken, checkout.body.cartId);
expect(order.status === 'placed' && order.total === 7560, 'cart.checked_out becomes an order for the discounted total');

const charge = await call(GATEWAY, '/payments/charges', { method: 'POST', token: user.body.accessToken, body: { orderId: order.id, method: 'card' } });
expect(charge.status === 202 && charge.body.status === 'pending' && charge.body.amount === 7560, 'payments charges the order total');
expect((await call(GATEWAY, '/payments/charges', { method: 'POST', token: user.body.accessToken, body: { orderId: order.id, method: 'wallet' } })).body.id === charge.body.id, 'charging the same order again returns the live payment');
expect(await webhook(charge.body.id, 'captured', 'wrong-secret') === 401, 'webhook with a bad signature is refused');
expect(await webhook(charge.body.id, 'captured') === 204, 'webhook with the right signature is accepted through the gateway');
expect(await webhook(charge.body.id, 'captured') === 204, 'a replayed webhook is harmless');
await eventually('order paid', async () => ((await call(GATEWAY, `/orders/${order.id}`, { token: user.body.accessToken })).body.status === 'paid' ? true : undefined));
console.log('ok  payment.captured moved the order to paid');

const staff = admin.body.accessToken;
const invoice = await eventually('invoice for the order', async () => { const r = await call(GATEWAY, `/invoices/order/${order.id}`, { token: staff }); return r.status === 200 ? r.body : undefined; });
expect(invoice.customerEmail === email && invoice.customerName === 'Smoke Test', "invoice carries the customer's name and email read from iam's database");
expect(invoice.total === 7560 && invoice.tax > 0 && invoice.subtotal + invoice.tax === invoice.total, 'invoice splits the paid total into subtotal and tax');
const credit = await call(GATEWAY, `/invoices/${invoice.id}/credit-notes`, { method: 'POST', token: staff, body: { amount: 1000, reason: 'smoke' } });
expect(credit.status === 201 && credit.body.credited === 1000, 'staff can issue a credit note');

const kinds = () => execFileSync('docker', ['compose', 'exec', '-T', 'postgres-notifications', 'psql', '-U', 'postgres', '-d', 'notifications', '-Atc', `SELECT kind FROM notifications WHERE recipient = '${email}' AND status = 'sent'`], { encoding: 'utf8' }).split('\n').filter(Boolean);
const sent = await eventually('welcome and order confirmation emails', () => { const k = kinds(); return k.includes('welcome') && k.includes('order_confirmation') ? k : undefined; });
expect(sent.length === 2, 'notifications sent exactly one welcome and one order confirmation');

// A payment that fails, then succeeds on a second attempt.
const second = `smoke2.${Date.now()}@shoplab.test`;
await call(IAM, '/auth/register', { method: 'POST', body: { email: second, password: 'password123', fullName: 'Smoke Retry' } });
const retryUser = (await call(IAM, '/auth/login', { method: 'POST', body: { email: second, password: 'password123' } })).body;
await call(CART, '/cart/items', { method: 'POST', token: retryUser.accessToken, body: { productId: created.body.id, quantity: 1 } });
const retryCheckout = await call(CART, '/cart/checkout', { method: 'POST', token: retryUser.accessToken });
const retryOrder = await orderFor(retryUser.accessToken, retryCheckout.body.cartId);
const first = await call(GATEWAY, '/payments/charges', { method: 'POST', token: retryUser.accessToken, body: { orderId: retryOrder.id, method: 'card' } });
expect(await webhook(first.body.id, 'failed') === 204, 'provider reports the first attempt failed');
const afterFailure = await call(GATEWAY, `/orders/${retryOrder.id}`, { token: retryUser.accessToken });
expect(afterFailure.body.status === 'placed', 'a failed payment leaves the order placed so the customer can retry');
const again = await call(GATEWAY, '/payments/charges', { method: 'POST', token: retryUser.accessToken, body: { orderId: retryOrder.id, method: 'card' } });
expect(again.status === 202 && again.body.id !== first.body.id, 'the retry is a new payment on the same order');
expect(await webhook(again.body.id, 'captured') === 204, 'provider captures the second attempt');
await eventually('retried order paid', async () => ((await call(GATEWAY, `/orders/${retryOrder.id}`, { token: retryUser.accessToken })).body.status === 'paid' ? true : undefined));
console.log('ok  the retried payment moved the order to paid');
const failedMail = await eventually('payment failed email', () => { const rows = execFileSync('docker', ['compose', 'exec', '-T', 'postgres-notifications', 'psql', '-U', 'postgres', '-d', 'notifications', '-Atc', `SELECT kind FROM notifications WHERE recipient = '${second}'`], { encoding: 'utf8' }); return rows.includes('payment_failed') ? rows : undefined; });
expect(failedMail.includes('payment_failed'), 'notifications told the customer about the failed payment');
console.log('smoke test passed');
