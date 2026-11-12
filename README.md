# shoplab-infra

Local stack, deployment config and shared CI for ShopLab.

- `docker-compose.yml`: a Postgres per service, RabbitMQ, Redis and the services: iam (3001), catalog-api (3002), cart-api (3003), orders (3004), payments (3005), invoices (3006), notifications (3007) and the gateway (8080, `GATEWAY_PORT`). Build contexts are sibling checkouts (`../shoplab-iam` and so on), so clone all repos side by side.
- `charts/<service>/`: Helm chart with `values.yaml`, `values-dev.yaml`, `values-prod.yaml`, one per service including the gateway. Env var names must match what the service reads (Node services in `src/`, payments in `app/`).
- `.github/workflows/service-ci.yml`: reusable workflow (typecheck, tests, optional Postgres migration test, image build).
- `config/feature-flags.json`: `checkout.v2`, `catalog.newSearch`.
- `deploy/outputs.dev.json`: `catalog_api_url`, `cdn_base_url`, `rabbit_url`.
- `deploy/invoices-reader.sql`: creates the read-only role the invoices service uses on iam's database (three columns of `users`). Compose runs it through the one-shot `iam-reader-grants` service; in a real environment a DBA applies it.

```
npm run up        # build and start the stack
npm run smoke     # seed every service, then register/login/add to cart/merge/checkout, pay through the gateway, and check the order, invoice and emails
npm run check:env # Helm env names vs service code
npm run validate  # docker compose config + check:env
npm run frontends # build and serve host + remotes on ports 5000-5004 (needs sibling checkouts)
npm run e2e       # Playwright journey in a real browser: browse, add to cart, register, merge, edit profile, coupon
npm run down
```

The e2e test needs `npm run up`, a seeded stack (`npm run smoke` seeds it) and `npm run frontends` running. Run `npx playwright install chromium` once.

## Secrets and shared values

The compose file has development defaults for every secret. Three values are shared between services and must match:

| Variable | Used by |
| --- | --- |
| `JWT_SECRET` | iam (signs), and every service and the gateway that verifies |
| `INVOICES_INTERNAL_KEY` | gateway (adds it as `x-internal-key`) and invoices (requires it) |
| `PAYMENT_WEBHOOK_SECRET` | payments (verifies the provider's signature); `npm run smoke` signs with the same value |

`GATEWAY_PORT` changes the published gateway port when 8080 is taken (`GATEWAY_URL` for `npm run smoke`).
