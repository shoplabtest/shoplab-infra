// Browser end-to-end test of the whole shop. Needs `npm run up` (backend) and `npm run frontends` (host + remotes) running,
// and the services seeded (`npm run smoke` seeds them). Fails on any console error or uncaught page error.
import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';

const HOST = process.env.HOST_URL ?? 'http://localhost:5000';
const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? 'dev-only-webhook-secret';
const step = (msg) => console.log(`ok  ${msg}`);

const browser = await chromium.launch();
const page = await browser.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource.*(404|405)/.test(m.text())) problems.push(`console: ${m.text()}`);
});

async function expectVisible(locator, what, timeout = 15000) {
  try { await locator.first().waitFor({ state: 'visible', timeout }); } catch { throw new Error(`e2e failed: ${what} never appeared`); }
  step(what);
}

try {
  await page.goto(HOST);
  await expectVisible(page.getByText('Prices in USD'), 'host loads the catalog remote');
  await expectVisible(page.getByRole('button', { name: 'Add to cart' }), 'catalog lists seeded products');

  await page.getByRole('button', { name: 'Add to cart' }).first().click();
  await expectVisible(page.getByText(/^Added p-seed\d+ to your cart$/), 'add to cart notifies the host (toast)');
  await expectVisible(page.getByRole('link', { name: 'Cart (1)' }), 'header cart count follows cart:updated');
  const guestCart = await page.evaluate(() => localStorage.getItem('cartId'));
  if (!guestCart) throw new Error('e2e failed: guest cart id was not saved in localStorage.cartId');
  step('guest cart id saved in localStorage.cartId');

  await page.getByRole('link', { name: 'Cart (1)' }).click();
  await expectVisible(page.getByRole('heading', { name: 'Your cart' }), 'host loads the cart remote');
  await page.getByRole('button', { name: /^Increase / }).click();
  await expectVisible(page.getByRole('link', { name: 'Cart (2)' }), 'quantity edit updates the cart count');

  await page.getByRole('link', { name: 'Log in', exact: true }).first().click();
  await expectVisible(page.getByRole('heading', { name: 'Log in' }), 'host loads the account remote');
  await page.getByRole('button', { name: 'Need an account?' }).click();
  const email = `e2e.${Date.now()}@shoplab.test`;
  await page.getByLabel('Full name').fill('E2E Shopper');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expectVisible(page.getByText(email), 'registration logs the shopper in and shows the profile');

  await page.waitForFunction(() => localStorage.getItem('cartId') === null, null, { timeout: 15000 });
  step('login merged the guest cart and cleared localStorage.cartId');
  await expectVisible(page.getByRole('link', { name: 'Cart (2)' }), 'merged cart keeps its items');

  await page.getByLabel('Full name').fill('E2E Renamed');
  await page.getByRole('button', { name: 'Save' }).click();
  await expectVisible(page.getByRole('status').filter({ hasText: 'Saved' }), 'profile edit saves through iam');

  await page.getByRole('link', { name: 'Cart (2)' }).click();
  await expectVisible(page.getByRole('heading', { name: 'Your cart' }), 'logged-in cart loads');
  await page.getByLabel('Coupon code').fill('WELCOME10');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expectVisible(page.getByText('Coupon WELCOME10 applied'), 'coupon applies');
  await expectVisible(page.getByText('Discount'), 'discount line shows');
  await expectVisible(page.getByRole('link', { name: 'Checkout' }), 'checkout link is offered to a logged-in shopper');

  // --- checkout: address, payment (the test plays the payment provider), confirmation -------------------------------
  await page.getByRole('link', { name: 'Checkout' }).click();
  await expectVisible(page.getByRole('form', { name: 'Delivery address' }), 'host loads the checkout remote on /checkout');
  await page.getByRole('button', { name: 'Continue to payment' }).click();
  await expectVisible(page.getByText('Enter the street address.'), 'an empty address is refused');
  await page.getByLabel('Full name').fill('E2E Shopper');
  await page.getByLabel('Address', { exact: true }).fill('1 Market St');
  await page.getByLabel('City').fill('San Francisco');
  await page.getByLabel('State').fill('CA');
  await page.getByLabel('Postal code').fill('94105');
  await page.getByRole('button', { name: 'Continue to payment' }).click();
  await expectVisible(page.getByRole('heading', { name: 'Review and pay' }), 'a valid address moves on to payment');
  await expectVisible(page.getByRole('region', { name: 'Order summary' }), 'the order summary lists the cart');

  const charged = page.waitForResponse((r) => r.url().endsWith('/payments/charges') && r.request().method() === 'POST', { timeout: 30000 });
  await page.getByRole('button', { name: 'Pay now' }).click();
  const payment = await (await charged).json();
  step('checkout placed the order and charged it');
  const raw = JSON.stringify({ paymentId: payment.id, outcome: 'captured' });
  const hook = await fetch(`${GATEWAY}/payments/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-provider-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex') },
    body: raw,
  });
  if (hook.status !== 204) throw new Error(`e2e failed: the provider webhook answered ${hook.status}`);
  await expectVisible(page.getByRole('heading', { name: 'Thank you for your order' }), 'the confirmation appears once the payment is captured', 30000);
  await expectVisible(page.getByRole('link', { name: 'Cart (0)' }), 'the header cart count resets after checkout');
  const leftover = await page.evaluate(() => sessionStorage.getItem('checkout.order'));
  if (leftover) throw new Error('e2e failed: checkout left its pending order in sessionStorage');
  step('a paid checkout forgets its in-progress order');

  if (problems.length) throw new Error(`e2e failed: browser reported problems:\n  ${problems.join('\n  ')}`);
  console.log('e2e passed');
} finally {
  if (process.env.E2E_SCREENSHOT) await page.screenshot({ path: process.env.E2E_SCREENSHOT, fullPage: true });
  await browser.close();
}
