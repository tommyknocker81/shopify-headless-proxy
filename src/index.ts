import { Hono } from "hono";
import inbox, { type InboxEnv } from "./inbox";

interface Env extends InboxEnv {
  /** Storefront API version, e.g. "2026-10". Set in wrangler vars. */
  STOREFRONT_API_VERSION?: string;
  /** Value for Access-Control-Allow-Origin. "*" or a specific domain. */
  ALLOWED_ORIGIN?: string;
}

const DEFAULT_API_VERSION = "2026-10";
const DEFAULT_ORIGIN = "*";
// Minimal fixed-cost query: only makes Shopify emit
// Set-Cookie (_shopify_y / _shopify_s) + Server-Timing (_y / _s).
// Hardcoded: clients cannot inject expensive queries.
const TRACK_QUERY = "{ shop { name } }";

const app = new Hono<{ Bindings: Env }>();

function apiVersion(c: { env: Env }): string {
  return c.env.STOREFRONT_API_VERSION || DEFAULT_API_VERSION;
}

function allowedOrigin(c: { env: Env }): string {
  return c.env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
}

// CORS preflight (triggered by the X-Shopify-* headers)
app.options("/_cks", (c) => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": allowedOrigin(c),
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers":
        "X-Shopify-Storefront-Access-Token, Shopify-Storefront-Y, Shopify-Storefront-S, Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
});

// GET /_cks?shop=xxx.myshopify.com[&pid=...]
// Header: X-Shopify-Storefront-Access-Token: <public token>
// Optional headers: Shopify-Storefront-Y / Shopify-Storefront-S
// (already known tokens, to continue visitor/session)
app.get("/_cks", async (c) => {
  const shop = c.req.query("shop") ?? "";
  const token = c.req.header("X-Shopify-Storefront-Access-Token") ?? "";

  // Anti open-proxy: only *.myshopify.com domains, only graphql.json
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
    return c.json({ error: "invalid shop parameter" }, 400);
  }
  if (!token) {
    return c.json({ error: "missing storefront token" }, 401);
  }

  const upstream = await fetch(
    `https://${shop}/api/${apiVersion(c)}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": token,
        // Forward known identity: Shopify continues the
        // visitor/session instead of minting new tokens
        ...(c.req.header("Shopify-Storefront-Y") && {
          "X-Shopify-UniqueToken": c.req.header("Shopify-Storefront-Y")!,
        }),
        ...(c.req.header("Shopify-Storefront-S") && {
          "X-Shopify-VisitToken": c.req.header("Shopify-Storefront-S")!,
        }),
      },
      body: JSON.stringify({ query: TRACK_QUERY }),
    }
  );

  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  // CORS + timing headers for cross-origin reads from the browser
  headers.set("Access-Control-Allow-Origin", allowedOrigin(c));
  headers.set("Access-Control-Expose-Headers", "server-timing");
  headers.set("Timing-Allow-Origin", "*");

  // Relay ALL Set-Cookie headers (not just the first one)
  const getSetCookie = (
    upstream.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie;
  if (typeof getSetCookie === "function") {
    for (const sc of getSetCookie.call(upstream.headers)) {
      headers.append("Set-Cookie", sc);
    }
  } else {
    const single = upstream.headers.get("set-cookie");
    if (single) headers.append("Set-Cookie", single);
  }

  const serverTiming = upstream.headers.get("server-timing");
  if (serverTiming) headers.set("Server-Timing", serverTiming);

  return new Response(JSON.stringify({ ok: upstream.ok, shop }), {
    status: upstream.ok ? 200 : 502,
    headers,
  });
});

// Optional: the Shopify Inbox chat for a headless storefront (src/inbox.ts).
app.route("/inbox", inbox);

export default app;
