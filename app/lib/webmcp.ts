/**
 * WebMCP "site tools" for Percolator — READ-ONLY exposure.
 *
 * Registers a small set of data tools with `document.modelContext` (the
 * WebMCP surface used by agent browsers) so an AI agent visiting this app
 * can discover and call the same read paths the UI already uses:
 *
 *   - get_percolator_feed_status — WS feed probe + the app's /api/health
 *   - list_percolator_markets    — GET /api/markets (same call as useAllMarketStats)
 *   - get_live_price             — the useLivePrice WS protocol (subscribe →
 *                                  price / price.updated), with the hook's own
 *                                  REST fallback (GET /api/markets/:slab last_price)
 *   - get_perps_market_data      — GET /api/markets/:slab + GET /api/prices/:slab
 *
 * HARD SCOPE: every tool is read-only. No order placement, no signing, no
 * wallet actions, no trading-gate changes. Handlers only call the app's
 * existing read logic and report degraded states honestly (e.g. when the
 * feed answers `oracle_unavailable`, that status is returned as-is instead
 * of a fabricated price).
 *
 * Registration is a no-op in browsers without WebMCP support.
 */

import { getBackendUrl } from "@/lib/config";
import { isBlockedSlab } from "@/lib/blocklist";

// ── WebMCP surface types (not yet in the TS DOM lib) ─────────────────────

export interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  annotations: { readOnlyHint: true };
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

interface WebMcpModelContext {
  registerTool: (tool: WebMcpTool) => unknown;
}

declare global {
  interface Document {
    modelContext?: WebMcpModelContext;
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────

/**
 * Same WS URL derivation as hooks/useLivePrice.ts: NEXT_PUBLIC_WS_URL wins,
 * otherwise derive from the configured backend URL (https→wss, http→ws).
 * Returns "" when no backend is configured.
 */
function getWsUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_WS_URL;
  if (explicit) return explicit;
  try {
    const apiUrl = getBackendUrl();
    return apiUrl.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
  } catch {
    return "";
  }
}

interface WsFrame {
  type?: string;
  slab?: string;
  slabAddress?: string;
  price?: number;
  timestamp?: number;
  error?: string;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

interface WsProbeResult {
  configured: boolean;
  connected: boolean;
  frames: WsFrame[];
  priceFrame: WsFrame | null;
  /** First error string reported by the feed (e.g. "oracle_unavailable"), if any. */
  feedError: string | null;
  /** Last status frame the feed sent, if any. */
  statusFrame: WsFrame | null;
}

/**
 * One-shot WebSocket probe of the price feed, speaking the exact protocol
 * useLivePrice uses: connect, send { type: "subscribe", slabAddress },
 * collect frames until a matching price frame arrives or the timeout hits.
 * Never throws — connection problems are reported in the result.
 */
function probeFeed(opts: { slabAddress?: string; timeoutMs: number }): Promise<WsProbeResult> {
  const wsUrl = getWsUrl();
  const empty: WsProbeResult = {
    configured: Boolean(wsUrl),
    connected: false,
    frames: [],
    priceFrame: null,
    feedError: null,
    statusFrame: null,
  };
  if (!wsUrl || typeof WebSocket === "undefined") {
    return Promise.resolve({ ...empty, feedError: wsUrl ? "websocket_unavailable" : "websocket_url_not_configured" });
  }

  return new Promise((resolve) => {
    const result: WsProbeResult = { ...empty, configured: true };
    let settled = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      resolve({ ...result, feedError: "websocket_connect_failed" });
      return;
    }

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (opts.slabAddress && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "unsubscribe", slabAddress: opts.slabAddress }));
        }
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(finish, opts.timeoutMs);

    ws.onopen = () => {
      result.connected = true;
      if (opts.slabAddress) {
        try {
          ws.send(JSON.stringify({ type: "subscribe", slabAddress: opts.slabAddress }));
        } catch {
          /* onclose/timeout will settle */
        }
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as WsFrame;
        result.frames.push(msg);
        if (msg.type === "status") result.statusFrame = msg;
        if (msg.type === "error" && !result.feedError) {
          result.feedError =
            (typeof msg.error === "string" && msg.error) ||
            (typeof msg.code === "string" && msg.code) ||
            (typeof msg.message === "string" && msg.message) ||
            "feed_error";
        }
        const isPrice =
          (msg.type === "price" || msg.type === "price.updated") &&
          typeof msg.price === "number" &&
          msg.price > 0 &&
          (!opts.slabAddress || msg.slab === opts.slabAddress || msg.slabAddress === opts.slabAddress);
        if (isPrice) {
          result.priceFrame = msg;
          finish();
        }
      } catch {
        /* ignore malformed frames */
      }
    };

    ws.onerror = () => {
      if (!result.feedError) result.feedError = "websocket_error";
    };
    ws.onclose = () => {
      finish();
    };
  });
}

async function fetchJson<T>(url: string): Promise<{ ok: boolean; status: number; body: T | null }> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    let body: T | null = null;
    try {
      body = (await res.json()) as T;
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

function requireSlabAddress(args: Record<string, unknown>): string | null {
  const v = args.slabAddress;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length >= 32 && trimmed.length <= 44 ? trimmed : null;
}

// ── Market row shapes (subset of the markets_with_stats view) ────────────

interface MarketStatsRow {
  slab_address: string | null;
  symbol: string | null;
  name: string | null;
  network: string | null;
  status: string | null;
  last_price: number | null;
  mark_price: number | null;
  index_price: number | null;
  funding_rate: number | null;
  open_interest_long: number | null;
  open_interest_short: number | null;
  total_open_interest: number | null;
  trade_count_24h: number | null;
  max_leverage: number | null;
  trading_fee_bps: number | null;
  stats_updated_at: string | null;
  [key: string]: unknown;
}

interface PricesStats {
  change24h?: number;
  high24h?: string;
  low24h?: string;
}

function stats24hOut(stats: PricesStats | null | undefined): Record<string, unknown> | null {
  if (!stats) return null;
  return {
    change24h: stats.change24h ?? null,
    high24hUsd: stats.high24h ? Number(stats.high24h) / 1_000_000 : null,
    low24hUsd: stats.low24h ? Number(stats.low24h) / 1_000_000 : null,
  };
}

// ── Tool implementations ─────────────────────────────────────────────────

async function getPercolatorFeedStatus(): Promise<Record<string, unknown>> {
  const [probe, health] = await Promise.all([
    probeFeed({ timeoutMs: 3_500 }),
    fetchJson<{ status?: string; api?: boolean; rpc?: boolean; ts?: number }>("/api/health"),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    websocket: {
      configured: probe.configured,
      url: getWsUrl() || null,
      connected: probe.connected,
      // Honest feed state as the server itself reported it (null if it didn't).
      statusFrame: probe.statusFrame,
      feedError: probe.feedError,
      framesReceived: probe.frames.length,
    },
    appHealth: health.body
      ? { status: health.body.status ?? null, api: health.body.api ?? null, rpc: health.body.rpc ?? null, ts: health.body.ts ?? null }
      : { status: "unreachable", httpStatus: health.status },
  };
}

async function listPercolatorMarkets(): Promise<Record<string, unknown>> {
  // Identical request to hooks/useAllMarketStats.ts.
  const res = await fetchJson<{ markets?: MarketStatsRow[]; error?: string }>(
    "/api/markets?include_zombie=true&limit=500",
  );
  if (!res.ok || !Array.isArray(res.body?.markets)) {
    return {
      status: "unavailable",
      reason: res.body?.error ?? `markets_api_http_${res.status}`,
      markets: [],
      count: 0,
    };
  }
  const all = res.body.markets.filter((m) => m.slab_address && !isBlockedSlab(m.slab_address));
  const markets = all.slice(0, 100).map((m) => ({
    slabAddress: m.slab_address,
    symbol: m.symbol,
    name: m.name,
    network: m.network,
    status: m.status,
    lastPriceUsd: m.last_price,
    markPriceUsd: m.mark_price,
    indexPriceUsd: m.index_price,
  }));
  return {
    status: "ok",
    count: markets.length,
    totalCount: all.length,
    truncated: all.length > markets.length,
    fetchedAt: new Date().toISOString(),
    markets,
  };
}

async function getLivePrice(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const slabAddress = requireSlabAddress(args);
  if (!slabAddress) {
    return { status: "invalid_input", reason: "slabAddress must be a base58 Solana address string (32–44 chars)" };
  }
  if (isBlockedSlab(slabAddress)) {
    return { status: "unavailable", reason: "market_blocked", slabAddress };
  }

  const probe = await probeFeed({ slabAddress, timeoutMs: 6_000 });
  if (probe.priceFrame) {
    return {
      status: "ok",
      slabAddress,
      priceUsd: probe.priceFrame.price,
      source: "websocket",
      serverTimestamp: probe.priceFrame.timestamp ?? null,
      receivedAt: new Date().toISOString(),
    };
  }

  // REST fallback — the same one useLivePrice uses (DB last_price + 24h stats).
  const [marketRes, pricesRes] = await Promise.all([
    fetchJson<{ market?: MarketStatsRow }>("/api/markets/" + encodeURIComponent(slabAddress)),
    fetchJson<{ stats?: PricesStats | null }>("/api/prices/" + encodeURIComponent(slabAddress)),
  ]);
  if (marketRes.status === 404) {
    return { status: "market_not_found", slabAddress, feedError: probe.feedError };
  }
  const lastPrice = marketRes.body?.market?.last_price;
  if (typeof lastPrice === "number" && lastPrice > 0) {
    return {
      status: "ok",
      slabAddress,
      priceUsd: lastPrice,
      source: "rest_last_price",
      stats24h: stats24hOut(pricesRes.body?.stats),
      feedError: probe.feedError,
      receivedAt: new Date().toISOString(),
    };
  }
  return {
    status: "unavailable",
    slabAddress,
    reason: probe.feedError ?? "no_price_from_feed_or_rest",
    feedConnected: probe.connected,
  };
}

async function getPerpsMarketData(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const slabAddress = requireSlabAddress(args);
  if (!slabAddress) {
    return { status: "invalid_input", reason: "slabAddress must be a base58 Solana address string (32–44 chars)" };
  }
  if (isBlockedSlab(slabAddress)) {
    return { status: "unavailable", reason: "market_blocked", slabAddress };
  }
  const [marketRes, pricesRes] = await Promise.all([
    fetchJson<{ market?: MarketStatsRow; error?: string }>("/api/markets/" + encodeURIComponent(slabAddress)),
    fetchJson<{ stats?: PricesStats | null }>("/api/prices/" + encodeURIComponent(slabAddress)),
  ]);
  if (marketRes.status === 404) {
    return { status: "market_not_found", slabAddress };
  }
  const m = marketRes.body?.market;
  if (!m) {
    return { status: "unavailable", slabAddress, reason: marketRes.body?.error ?? `markets_api_http_${marketRes.status}` };
  }
  // Pass the view's own fields through under their own names — no invented
  // units or derived values.
  return {
    status: "ok",
    slabAddress,
    symbol: m.symbol,
    name: m.name,
    network: m.network,
    marketStatus: m.status,
    last_price: m.last_price,
    mark_price: m.mark_price,
    index_price: m.index_price,
    funding_rate: m.funding_rate,
    open_interest_long: m.open_interest_long,
    open_interest_short: m.open_interest_short,
    total_open_interest: m.total_open_interest,
    trade_count_24h: m.trade_count_24h,
    max_leverage: m.max_leverage,
    trading_fee_bps: m.trading_fee_bps,
    stats_updated_at: m.stats_updated_at,
    stats24h: stats24hOut(pricesRes.body?.stats),
    fetchedAt: new Date().toISOString(),
  };
}

// ── Registration ─────────────────────────────────────────────────────────

const SLAB_ADDRESS_SCHEMA = {
  type: "string",
  description: "Percolator market slab address (Solana public key, base58). Get one from list_percolator_markets.",
  minLength: 32,
  maxLength: 44,
} as const;

export const PERCOLATOR_WEBMCP_TOOLS: WebMcpTool[] = [
  {
    name: "get_percolator_feed_status",
    description:
      "Read-only: report the current state of the Percolator live price feed as this app sees it — whether the WebSocket feed connects, the status frame the feed server itself sends, any feed error (e.g. oracle_unavailable), and the app's backend/RPC health. No trading action.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: async () => getPercolatorFeedStatus(),
  },
  {
    name: "list_percolator_markets",
    description:
      "Read-only: list the Percolator perpetual markets this app tracks, with each market's slab address, symbol, name, network, status, and last/mark/index prices (USD) when available. No trading action.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: async () => listPercolatorMarkets(),
  },
  {
    name: "get_live_price",
    description:
      "Read-only: get the latest price (USD) for one Percolator market by slab address, from the live WebSocket feed when it answers, otherwise from the app's REST last-price fallback (the source field says which). Returns an honest unavailable status — including the feed's own error such as oracle_unavailable — when no price exists. Never fabricates a price. No trading action.",
    inputSchema: {
      type: "object",
      properties: { slabAddress: SLAB_ADDRESS_SCHEMA },
      required: ["slabAddress"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: getLivePrice,
  },
  {
    name: "get_perps_market_data",
    description:
      "Read-only: get per-market perpetuals data this app already displays for one market by slab address — last/mark/index price, funding rate, open interest (long/short/total), 24h trade count, max leverage, trading fee, and 24h price stats — passed through under the app's own field names. No trading action.",
    inputSchema: {
      type: "object",
      properties: { slabAddress: SLAB_ADDRESS_SCHEMA },
      required: ["slabAddress"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: getPerpsMarketData,
  },
];

let registered = false;

/**
 * Register the Percolator read-only tools with the browser's WebMCP
 * surface. No-op (returns false) where WebMCP is unsupported, and safe to
 * call more than once.
 */
export function registerPercolatorWebMcpTools(): boolean {
  if (registered) return true;
  if (typeof document === "undefined") return false;
  const mc = document.modelContext;
  if (!mc || typeof mc.registerTool !== "function") return false;
  registered = true;
  for (const tool of PERCOLATOR_WEBMCP_TOOLS) {
    try {
      const out = mc.registerTool(tool) as unknown;
      if (out && typeof (out as { catch?: unknown }).catch === "function") {
        (out as Promise<unknown>).catch(() => {
          /* a rejected registration must never break the page */
        });
      }
    } catch {
      /* WebMCP registration failures must never break the page */
    }
  }
  return true;
}
