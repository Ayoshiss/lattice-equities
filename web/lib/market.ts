// Live market data for the order ticket: Pyth's TSLA price, US market hours,
// price history for the chart, and the Arcium MXE key that orders are
// encrypted to. Server only (all of it needs a secret or an RPC).
import "server-only";
import { AnchorProvider } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getMXEPublicKey } from "@arcium-hq/client";
import idl from "./idl.json";

const TSLA_FEED = "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1";
const TSLA_SYMBOL = "Equity.US.TSLA/USD";
const HISTORY_URL = "https://pyth.dourolabs.app/v1/fixed_rate@200ms/history";

export type Session = { isOpen: boolean; nextOpen: number | null; nextClose: number | null };
export type Market = {
  tsla: { price: number; conf: number; publishTime: number } | null;
  session: Session | null;
  mxeKey: string;
};

export const RANGES = {
  "1D": { resolution: "15", lookback: 4 * 86400, keep: 86400 }, // last day with data, even over a weekend
  "1W": { resolution: "60", lookback: 7 * 86400, keep: 7 * 86400 },
  "1M": { resolution: "240", lookback: 31 * 86400, keep: 31 * 86400 },
} as const;
export type Range = keyof typeof RANGES;
export type History = { t: number[]; c: number[] };

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

function pythHeaders() {
  const key = process.env.PYTH_API_KEY;
  if (!key) throw new Error("PYTH_API_KEY is not set");
  return { Authorization: `Bearer ${key}` };
}

let mxeKey: string | null = null;
async function loadMxeKey() {
  if (mxeKey) return mxeKey;
  const url = process.env.RPC_URL;
  if (!url) throw new Error("RPC_URL is not set");
  // Read only, so the wallet never signs anything.
  const wallet = { publicKey: Keypair.generate().publicKey } as any;
  const provider = new AnchorProvider(new Connection(url, "confirmed"), wallet, {});
  const key = await getMXEPublicKey(provider, new PublicKey(idl.address));
  if (!key) throw new Error("MXE key not set on devnet");
  mxeKey = Buffer.from(key).toString("hex");
  return mxeKey;
}

function loadTsla(): Promise<Market["tsla"]> {
  return cached("tsla", 5_000, async () => {
    const r = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${TSLA_FEED}&parsed=true`, {
      headers: pythHeaders(),
      cache: "no-store",
    });
    if (!r.ok) return null;
    const p = (await r.json()).parsed?.[0]?.price;
    if (!p) return null;
    const scale = 10 ** p.expo;
    return { price: Number(p.price) * scale, conf: Number(p.conf) * scale, publishTime: p.publish_time };
  });
}

// Regular US trading hours, as Pyth publishes them for the feed.
function loadSession(): Promise<Session | null> {
  return cached("session", 60_000, async () => {
    const r = await fetch(`https://benchmarks.pyth.network/v1/price_feeds/${TSLA_FEED}`, { headers: pythHeaders(), cache: "no-store" });
    if (!r.ok) return null;
    const h = (await r.json()).market_hours;
    return h ? { isOpen: !!h.is_open, nextOpen: h.next_open ?? null, nextClose: h.next_close ?? null } : null;
  });
}

export async function getMarket(): Promise<Market> {
  const [mxe, tsla, session] = await Promise.all([
    loadMxeKey(),
    loadTsla().catch(() => null),
    loadSession().catch(() => null),
  ]);
  return { mxeKey: mxe, tsla, session };
}

export function getHistory(range: Range): Promise<History> {
  return cached(`history:${range}`, 60_000, async () => {
    const { resolution, lookback, keep } = RANGES[range];
    const to = Math.floor(Date.now() / 1000);
    const q = new URLSearchParams({ symbol: TSLA_SYMBOL, resolution, from: String(to - lookback), to: String(to) });
    const r = await fetch(`${HISTORY_URL}?${q}`, { headers: pythHeaders(), cache: "no-store" });
    if (!r.ok) throw new Error(`Pyth history ${r.status}`);
    const d = await r.json();
    if (d.s !== "ok" || !d.t?.length) return { t: [], c: [] };
    const since = d.t[d.t.length - 1] - keep;
    const start = d.t.findIndex((t: number) => t >= since);
    return { t: d.t.slice(start), c: d.c.slice(start) };
  });
}
