// End-to-end smoke test against the running Compose stack: seed, log in, create a product, shop as a guest, merge, check out.
import { execFileSync } from 'node:child_process';

const IAM = process.env.IAM_URL ?? 'http://localhost:3001';
const CATALOG = process.env.CATALOG_URL ?? 'http://localhost:3002';
const CART = process.env.CART_URL ?? 'http://localhost:3003';
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
}
await Promise.all([waitFor(IAM, 'iam'), waitFor(CATALOG, 'catalog-api'), waitFor(CART, 'cart-api')]);

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
console.log('smoke test passed');
