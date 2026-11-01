# shoplab-infra

Local stack, deployment config and shared CI for ShopLab.

- `docker-compose.yml`: Postgres per service, RabbitMQ, Redis, iam, catalog-api, cart-api. Build contexts are sibling checkouts (`../shoplab-iam` and so on), so clone all repos side by side.
- `charts/<service>/`: Helm chart with `values.yaml`, `values-dev.yaml`, `values-prod.yaml`. Env var names must match what the service reads.
- `.github/workflows/service-ci.yml`: reusable workflow (typecheck, tests, optional Postgres migration test, image build).
- `config/feature-flags.json`: `checkout.v2`, `catalog.newSearch`.
- `deploy/outputs.dev.json`: `catalog_api_url`, `cdn_base_url`, `rabbit_url`.

```
npm run up        # build and start the stack
npm run smoke     # seed, then register/login/add to cart/merge/checkout end to end
npm run check:env # Helm env names vs service code
npm run frontends # build and serve host + remotes on ports 5000-5003 (needs sibling checkouts)
npm run e2e       # Playwright journey in a real browser: browse, add to cart, register, merge, edit profile, coupon
npm run down
```

The e2e test needs `npm run up`, a seeded stack (`npm run smoke` seeds it) and `npm run frontends` running. Run `npx playwright install chromium` once.
