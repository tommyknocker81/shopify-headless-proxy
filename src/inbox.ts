import { Hono, type Context } from "hono";

// Optional: the new Shopify Inbox chat on a headless storefront (Webflow + Smootify).
// The chat (cdn.shopify.com/storefront/web-components/chat.js) opens its panel as an iframe on
// <your site>/agent/buyer-claims, a route only Shopify's own storefronts serve. Smootify's
// inbox.js script sends that iframe here (its data-proxy attribute), and this worker asks the
// store for it the way Hydrogen's server does: Sec-Shopify-Storefront-Origin set to your site's
// origin. Shopify accepts only an origin that is one of the store's domains (Settings > Domains,
// connected or not).
//
// The visitor: on the store, Shopify's _shopify_essential cookie brings the same visitor back to
// their conversation. Here GET /inbox/session hands the page that session sealed (AES-GCM, key from
// the INBOX_SEAL_KEY secret, the store and the site's origin as authenticated data): the page
// keeps it and sends it back as `sid`, and only this worker can open it, only for that store and
// that site. Without INBOX_SEAL_KEY the chat still works, as a new visitor on every visit.

export interface InboxEnv {
  /** The store this proxy serves, e.g. "my-shop.myshopify.com". Required for the chat. */
  SHOP?: string;
  /** Secret: any long random string. Seals the visitors' sessions. */
  INBOX_SEAL_KEY?: string;
  /** Value for Access-Control-Allow-Origin. "*" or a specific domain. */
  ALLOWED_ORIGIN?: string;
}

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const SESSION_RE = /^[A-Za-z0-9%._~+/=:-]{8,2048}$/;
const SEALED = "v1.";
/** The script's parameters, not the chat's: they don't go on to Shopify. */
const OWN_PARAMS = new Set(["pid", "sid", "origin"]);

type Ctx = Context<{ Bindings: InboxEnv }>;

function shopOf(env: InboxEnv): string | null {
  const shop = (env.SHOP || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return SHOP_RE.test(shop) ? shop : null;
}

function pageOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** As a browser would ask: Shopify answers 406 to a request that doesn't look like one. */
function shopifyHeaders(c: Ctx, origin: string, session?: string | null) {
  const headers: Record<string, string> = {
    "Sec-Shopify-Storefront-Origin": origin,
    "User-Agent": c.req.header("user-agent") || "Mozilla/5.0",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": c.req.header("accept-language") || "en",
  };
  if (session) headers.Cookie = `_shopify_essential=${session}`;
  return headers;
}

function essentialCookie(response: Response): string | null {
  for (const cookie of response.headers.getSetCookie()) {
    const match = cookie.match(/^_shopify_essential=([^;]*)/);
    if (match) return match[1];
  }
  return null;
}

const encoder = new TextEncoder();
const fromBase64Url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let sealing: { secret: string; key: Promise<CryptoKey> } | undefined;

/** The AES-GCM key derived from INBOX_SEAL_KEY (SHA-256 of it); null without the secret. */
function sealKey(env: InboxEnv): Promise<CryptoKey> | null {
  const secret = env.INBOX_SEAL_KEY;
  if (!secret) return null;
  if (sealing?.secret !== secret) {
    sealing = {
      secret,
      key: crypto.subtle
        .digest("SHA-256", encoder.encode(secret))
        .then((raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"])),
    };
  }
  return sealing.key;
}

const sealedFor = (shop: string, origin: string) => encoder.encode(`${shop}|${origin}`);

async function sealSession(key: CryptoKey, session: string, shop: string, origin: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: sealedFor(shop, origin) }, key, encoder.encode(session)));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return SEALED + toBase64Url(out);
}

async function openSession(key: CryptoKey, value: string | undefined, shop: string, origin: string): Promise<string | null> {
  if (!value?.startsWith(SEALED) || value.length > 4096) return null;
  try {
    const raw = fromBase64Url(value.slice(SEALED.length));
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12), additionalData: sealedFor(shop, origin) }, key, raw.slice(12));
    const session = new TextDecoder().decode(plain);
    return SESSION_RE.test(session) ? session : null;
  } catch {
    return null;
  }
}

/** What the chat panel shows when it can't open here. The script reads the reason from /inbox/session. */
function unavailable(status: 400 | 404 | 409 | 502) {
  return new Response("The chat isn't available right now.", {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const inbox = new Hono<{ Bindings: InboxEnv }>();

/** The visitor's session for the chat, sealed for the page: the `sid` it sends back if it still opens, else a new one. */
inbox.get("/session", async (c) => {
  c.header("Access-Control-Allow-Origin", c.env.ALLOWED_ORIGIN || "*");
  c.header("Cache-Control", "no-store");
  const origin = pageOrigin(c.req.header("origin"));
  if (!origin) return c.json({ error: "origin-required" }, 400);
  const shop = shopOf(c.env);
  if (!shop) return c.json({ error: "no-store" }, 409);
  const key = await sealKey(c.env);
  if (!key) return c.json({ error: "no-seal-key" }, 409);

  const held = c.req.query("sid");
  if (await openSession(key, held, shop, origin)) return c.json({ sid: held });

  const answer = await fetch(`https://${shop}/agent/buyer-claims`, { redirect: "manual", headers: shopifyHeaders(c, origin) });
  // Shopify issues a session even with its 404, but the chat won't open for this origin.
  if (answer.status === 404) return c.json({ error: "not-a-store-domain" }, 404);
  const session = essentialCookie(answer);
  if (!session) return c.json({ error: "no-session" }, 502);
  return c.json({ sid: await sealSession(key, session, shop, origin) });
});

/** The chat panel's iframe: the store's redirect to its chat shell, for the page's origin and with the visitor's session. */
inbox.get("/agent/buyer-claims", async (c) => {
  // inbox.js asks the browser to send only the page's origin as Referer; `origin` is for a browser that sends none.
  const origin = pageOrigin(c.req.header("referer")) ?? pageOrigin(c.req.query("origin"));
  if (!origin) return unavailable(400);
  const shop = shopOf(c.env);
  if (!shop) return unavailable(409);
  const key = await sealKey(c.env);
  const session = key ? await openSession(key, c.req.query("sid"), shop, origin) : null;

  const upstream = new URL(`https://${shop}/agent/buyer-claims`);
  for (const [name, value] of new URL(c.req.url).searchParams) {
    if (!OWN_PARAMS.has(name)) upstream.searchParams.append(name, value);
  }
  const answer = await fetch(upstream, { redirect: "manual", headers: shopifyHeaders(c, origin, session) });
  const location = answer.headers.get("location");
  if (location && answer.status >= 300 && answer.status < 400) {
    return new Response(null, {
      status: 302,
      // A relative location is the store's, not this worker's.
      headers: { Location: new URL(location, upstream).toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  }
  return unavailable(answer.status === 404 ? 404 : 502);
});

export default inbox;
