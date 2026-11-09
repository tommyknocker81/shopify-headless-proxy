# shopify-headless-proxy

Self-hosted Shopify proxy for headless storefronts (Webflow + Smootify), on your own Cloudflare account. It does two things, each with one small call:

- **Analytics** (`/_cks`): one call per session makes Shopify issue its first-party visitor and session tokens (`_y` / `_s`), without routing the Storefront API traffic through the worker. Needed since Shopify stopped reading the `shopify_y` / `shopify_s` cookies (April 30, 2026): without a proxy, visitor/session attribution in Shopify Analytics degrades.
- **Shopify Inbox chat** (`/inbox`, optional): the new Inbox chat opens its panel on a route only Shopify's own storefronts serve. The proxy asks the store for it on your site's behalf, once per chat opening.

Smootify's Server plan includes both on Smootify's own proxy: this repository is for the other plans.

## 1-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/smootify/shopify-headless-proxy)

1. Click the button, log in to Cloudflare, confirm the deploy.
2. You get a URL like `https://shopify-headless-proxy.<your-account>.workers.dev`.

No DNS changes needed: the endpoints work cross-origin via CORS, even on a `workers.dev` subdomain. It stays within the Cloudflare free plan (100k requests/day included).

## Configuration

Variables go in `wrangler.jsonc` under `vars`, or in the dashboard (Workers & Pages → your Worker → Settings → Variables and Secrets):

| Variable | Default | Description |
|---|---|---|
| `STOREFRONT_API_VERSION` | `2026-10` | Storefront API version used upstream (analytics) |
| `ALLOWED_ORIGIN` | `*` | Value of `Access-Control-Allow-Origin`. Use a specific domain (e.g. `https://www.myshop.com`) to restrict callers |
| `SHOP` | | Your store, e.g. `my-shop.myshopify.com`. Required for the Inbox chat |

Secret (Settings → Variables and Secrets → Add → Secret, or `npx wrangler secret put INBOX_SEAL_KEY`):

| Secret | Description |
|---|---|
| `INBOX_SEAL_KEY` | Any long random string. Lets a returning visitor get their chat conversation back; without it the chat works, as a new visitor on every visit |

## Analytics: Webflow setup

In **Site Settings → Custom Code → Head section**, before the Smootify script:

```html
<script>window.smootifyCksEndpoint = "https://shopify-headless-proxy.<your-account>.workers.dev/_cks";</script>
```

Smootify calls it automatically (once per session, only with tracking consent). No other changes needed in Webflow.

## Shopify Inbox chat: setup

1. Set `SHOP` and the `INBOX_SEAL_KEY` secret (above).
2. In Shopify, **Settings → Domains**: add your Webflow domain (e.g. `www.myshop.com`) without connecting it. Shopify opens the chat only on the store's domains.
3. In the Inbox settings, turn off **Require sign-in to chat with staff**.
4. In the Smootify dashboard, **App embeds** gives the chat's code from a page of your store. Add your proxy to its `inbox.js` script, followed by `/inbox`:

```html
<script src="https://cdn.smootify.io/assets/inbox/v1/inbox.js" data-proxy="https://shopify-headless-proxy.<your-account>.workers.dev/inbox"></script>
```

## Manual deploy

```bash
npm install
npm run deploy   # requires logged-in wrangler: npx wrangler login
```

## How it works

```
Analytics
browser ──GET /_cks?shop=xxx.myshopify.com──▶ worker ──POST { shop { name } }──▶ Shopify
browser ◀── Set-Cookie + Server-Timing (_y/_s) ── worker ◀──┘

Inbox chat
page ──GET /inbox/session──▶ worker ──▶ Shopify: a session for this visitor, sealed for the page
chat iframe ──GET /inbox/agent/buyer-claims?sid=…──▶ worker ──▶ Shopify (Sec-Shopify-Storefront-Origin: your site)
chat iframe ◀── 302 to Shopify's chat, allowed only inside your site ──┘
```

- `/_cks`: `shop` is validated against `*.myshopify.com` (anti open-proxy). The GraphQL query is **fixed and minimal**, not injectable by the client → fixed cost per hit. `Shopify-Storefront-Y/S` headers are forwarded as `X-Shopify-UniqueToken/VisitToken` → visitor/session continuity. CORS + `Timing-Allow-Origin` headers for cross-origin reads from the browser.
- `/inbox`: only the store in `SHOP`. The visitor's Shopify session reaches the page only sealed (AES-GCM, with the store and the site's origin as authenticated data): Shopify can't use it, and the worker opens it only for that store on that site.

## Verify

```js
fetch("https://shopify-headless-proxy.<your-account>.workers.dev/_cks?shop=YOUR-SHOP.myshopify.com", {
  headers: { "X-Shopify-Storefront-Access-Token": "PUBLIC_TOKEN" },
}).then(r => r.headers.get("server-timing")); // must show _y and _s
```

From a page of your site, in the browser console:

```js
fetch("https://shopify-headless-proxy.<your-account>.workers.dev/inbox/session").then(r => r.json()); // { sid: "v1.…" }
```

`{ "error": "not-a-store-domain" }` means the site's domain isn't among the store's domains in Shopify yet.
