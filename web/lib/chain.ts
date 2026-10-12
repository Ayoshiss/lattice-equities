// Reads Lattice Equities state from Solana devnet. Server only: the RPC URL
// carries an API key, so browsers go through our routes instead.
import "server-only";
import { BorshCoder, EventParser } from "@anchor-lang/core";
import { Connection, PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import bs58 from "bs58";
import idl from "./idl.json";

const PROGRAM_ID = new PublicKey(idl.address);
const BOOK_SIZE = 844; // current Book layout; older devnet books used a shorter one
const BOOK_DISCRIMINATOR = Buffer.from([121, 34, 121, 35, 91, 62, 85, 222]);

const FEEDS: Record<string, string> = {
  ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d: "SOL/USD",
  "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1": "TSLA/USD",
  "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688": "AAPL/USD",
  "978e6cc68a119ce066aa830017318563a9ed04ec3a0a6439010fc11296a58675": "AAPLX/USD",
};
const STATUS = ["open", "clearing", "cleared", "dead"] as const;

const coder = new BorshCoder(idl as any);
const events = new EventParser(PROGRAM_ID, coder);

function connection() {
  const url = process.env.RPC_URL;
  if (!url) throw new Error("RPC_URL is not set");
  return new Connection(url, "confirmed");
}

// Small in-memory cache so many viewers polling the page don't each hit the RPC.
const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

const num = (v: any) => (typeof v === "number" ? v : Number(v.toString()));
const hex = (bytes: number[] | Uint8Array) => Buffer.from(bytes).toString("hex");

export type BookSummary = {
  address: string;
  status: (typeof STATUS)[number];
  feed: string;
  orderCount: number;
  clearingPrice: number | null;
  bandLo: number | null;
  bandHi: number | null;
  matchedLots: number;
  sharesPerLot: number;
  lastOrderAt: number;
};

function summarize(address: string, b: any): BookSummary {
  // Prices are stored in quote atoms per lot; show dollars per share.
  const q = 10 ** b.quote_decimals * (num(b.lot_size) / 10 ** b.base_decimals);
  const cleared = b.status === 2;
  return {
    address,
    status: STATUS[b.status] ?? "open",
    feed: FEEDS[hex(b.price_feed_id)] ?? "Pyth feed",
    orderCount: b.order_count,
    clearingPrice: cleared ? b.clearing_price / q : null,
    sharesPerLot: num(b.lot_size) / 10 ** b.base_decimals,
    bandLo: b.band_lo ? b.band_lo / q : null,
    bandHi: b.band_hi ? b.band_hi / q : null,
    matchedLots: num(b.matched),
    lastOrderAt: num(b.last_order_at),
  };
}

export function listBooks(): Promise<BookSummary[]> {
  return cached("books", 8_000, async () => {
    const accounts = await connection().getProgramAccounts(PROGRAM_ID, {
      filters: [{ dataSize: BOOK_SIZE }, { memcmp: { offset: 0, bytes: bs58.encode(BOOK_DISCRIMINATOR) } }],
    });
    return accounts
      .map((a) => summarize(a.pubkey.toBase58(), coder.accounts.decode("Book", a.account.data)))
      .sort((x, y) => y.lastOrderAt - x.lastOrderAt);
  });
}

export type SealedOrder = {
  index: number;
  tx: string;
  time: number | null;
  trader: string;
  side: "buy" | "sell";
  deposit: number; // in shares for a sell, in quote for a buy
  encryptedSide: string;
  encryptedPrice: string;
  encryptedQty: string;
};
export type Settlement = { slot: number; trader: string; tx: string; time: number | null; shares: number; quote: number };
export type TimelineEntry = { kind: string; tx: string; time: number | null; detail: string };
export type BookDetail = BookSummary & {
  encryptedBook: string[];
  bandBps: number;
  fills: number[];
  orders: SealedOrder[];
  clear: { tx: string; time: number | null; usedFallback: boolean } | null;
  settlements: Settlement[];
  timeline: TimelineEntry[];
};

function accountKeys(tx: VersionedTransactionResponse) {
  const m = tx.transaction.message;
  const keys = m.staticAccountKeys.map((k) => k.toBase58());
  const loaded = tx.meta?.loadedAddresses;
  return loaded ? [...keys, ...loaded.writable.map((k) => k.toBase58()), ...loaded.readonly.map((k) => k.toBase58())] : keys;
}

export function getBook(address: string): Promise<BookDetail | null> {
  return cached(`book:${address}`, 6_000, async () => {
    const conn = connection();
    const key = new PublicKey(address);
    const info = await conn.getAccountInfo(key);
    if (!info || !info.owner.equals(PROGRAM_ID) || info.data.length !== BOOK_SIZE) return null;
    const b: any = coder.accounts.decode("Book", info.data);
    const base = 10 ** b.base_decimals, quote = 10 ** b.quote_decimals;

    const sigs = await conn.getSignaturesForAddress(key, { limit: 100 });
    const ok = sigs.filter((s) => !s.err).reverse();
    const txs = ok.length
      ? await conn.getTransactions(ok.map((s) => s.signature), { maxSupportedTransactionVersion: 0, commitment: "confirmed" })
      : [];

    const orders: SealedOrder[] = [];
    const settlements: Settlement[] = [];
    const timeline: TimelineEntry[] = [];
    let clear: BookDetail["clear"] = null;

    txs.forEach((tx, i) => {
      if (!tx) return;
      const sig = ok[i].signature, time = tx.blockTime ?? null;
      const keys = accountKeys(tx);
      for (const ix of tx.transaction.message.compiledInstructions) {
        if (keys[ix.programIdIndex] !== PROGRAM_ID.toBase58()) continue;
        const d = coder.instruction.decode(Buffer.from(ix.data));
        if (d?.name !== "submit_order") continue;
        const a: any = d.data;
        const baseDep = num(a.base_deposit), quoteDep = num(a.quote_deposit);
        orders.push({
          index: orders.length,
          tx: sig,
          time,
          trader: keys[ix.accountKeyIndexes[0]],
          side: baseDep > 0 ? "sell" : "buy",
          deposit: baseDep > 0 ? baseDep / base : quoteDep / quote,
          encryptedSide: hex(a.encrypted_side),
          encryptedPrice: hex(a.encrypted_price),
          encryptedQty: hex(a.encrypted_qty),
        });
      }
      for (const ev of events.parseLogs(tx.meta?.logMessages ?? [])) {
        const e: any = ev.data;
        switch (ev.name) {
          case "BookReadyEvent":
            timeline.push({ kind: "Book opened", tx: sig, time, detail: "Encrypted empty book created by Arcium" });
            break;
          case "OrderPlacedEvent":
            timeline.push({ kind: "Order sealed", tx: sig, time, detail: `Order ${e.order_count} added to the encrypted book` });
            break;
          case "OrderFailedEvent":
            timeline.push({ kind: "Order failed", tx: sig, time, detail: "Refundable in full" });
            break;
          case "OrderCancelledEvent":
            timeline.push({ kind: "Order cancelled", tx: sig, time, detail: `Slot ${e.slot + 1} refunded` });
            break;
          case "BatchClearedEvent":
            clear = { tx: sig, time, usedFallback: e.used_fallback };
            const perShare = e.clearing_price / quote / (num(b.lot_size) / base);
            timeline.push({ kind: "Batch cleared", tx: sig, time, detail: `$${perShare.toFixed(2)} per share, ${num(e.matched)} lots matched` });
            break;
          case "ClearFailedEvent":
            timeline.push({ kind: "Clear failed", tx: sig, time, detail: "Book reopened" });
            break;
          case "OrderSettledEvent":
            settlements.push({ slot: e.slot, trader: e.trader.toBase58(), tx: sig, time, shares: num(e.base_out) / base, quote: num(e.quote_out) / quote });
            timeline.push({ kind: "Settled", tx: sig, time, detail: `Order ${e.slot + 1} paid out` });
            break;
          case "PendingExpiredEvent":
            timeline.push({ kind: "Timed out", tx: sig, time, detail: "Stuck computation released" });
            break;
        }
      }
    });

    return {
      ...summarize(address, b),
      encryptedBook: (b.encrypted_book as number[][]).map(hex),
      bandBps: b.band_bps,
      fills: (b.fills as any[]).slice(0, b.order_count).map(num),
      orders,
      clear,
      settlements,
      timeline,
    };
  });
}
