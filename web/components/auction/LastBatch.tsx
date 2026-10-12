"use client";
// Inside the most recent devnet batch: the pipeline as a timeline, every sealed order,
// and how buys met sells at one price. Polls devnet so a demo run shows up live.
import { useEffect, useState } from "react";
import type { BookDetail, BookSummary } from "@/lib/chain";
import { ago, explorer, groups, short, usd } from "@/lib/format";

const POLL_MS = 10_000;
const BUY = "#B9B4FF", SELL = "#FF8A73";

function Lock() {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-night">
      <svg width="11" height="13" viewBox="0 0 12 14" aria-hidden="true"><path d="M3 6V4a3 3 0 0 1 6 0v2" stroke="#FFB547" strokeWidth="1.8" fill="none" /><rect x="1" y="6" width="10" height="7.5" rx="2" fill="#FFB547" /></svg>
    </span>
  );
}

export default function LastBatch({ initial, now: serverNow }: { initial: BookDetail | null; now: number }) {
  const [book, setBook] = useState(initial);
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const books: BookSummary[] = await fetch("/api/books").then((r) => r.json());
        const top = books.find((b) => b.orderCount > 0);
        if (top) {
          const d: BookDetail = await fetch(`/api/books/${top.address}`).then((r) => r.json());
          if (live && d?.address) setBook(d);
        }
      } catch {}
      if (live) setNow(Date.now() / 1000);
    };
    const t = setInterval(poll, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, []);

  if (!book) return null;
  const n = book.orderCount;
  const cleared = book.status === "cleared";
  const shares = (lots: number) => lots * book.sharesPerLot;
  const times = book.orders.map((o) => o.time).filter((t): t is number => t !== null);
  const firstAt = Math.min(...times), lastAt = Math.max(...times);
  const paid = new Set(book.settlements.map((s) => s.slot)).size;
  const lastEvent = book.timeline.at(-1)?.time ?? lastAt;
  const steps = [
    { done: true, k: "Sealed", v: `${n} orders${times.length > 1 ? ` over ${lastAt - firstAt}s` : ""}` },
    { done: cleared, k: "Pyth checked", v: `${book.feed}, on-chain${book.clear?.usedFallback ? ", fallback feed" : ""}` },
    { done: cleared, k: "Cleared in Arcium", v: cleared && book.clear?.time ? `in ${book.clear.time - lastAt}s, nothing decrypted` : "nothing decrypted" },
    { done: cleared && paid === n, k: "Settled", v: `${paid} of ${n} paid out` },
  ];
  const links = [["Book", explorer("address", book.address)], ["Clear", book.clear && explorer("tx", book.clear.tx)], ["Payout", book.settlements[0] && explorer("tx", book.settlements[0].tx)]].filter(([, h]) => h) as string[][];

  return (
    <section id="batch" className="w-full scroll-mt-6 rounded-3xl border border-line bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-4 sm:px-8">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="text-[13px] font-extrabold uppercase tracking-[1.6px] text-indigo">Inside the last batch</span>
          <span className="font-mono text-[12px] text-muted">{short(book.address)} · {cleared ? `cleared at ${usd(book.clearingPrice!)}` : book.status} · {ago(now - lastEvent)} ago</span>
        </div>
        <div className="flex gap-1.5 font-mono text-[12px]">
          {links.map(([l, h]) => <a key={l} href={h} target="_blank" rel="noreferrer" className="rounded-full bg-page px-3 py-1.5 text-body hover:bg-night hover:text-[#F7F7FA]">{l} ↗</a>)}
        </div>
      </div>

      <div className="grid gap-10 p-6 sm:p-8 lg:grid-cols-12">
        <ol className="relative flex flex-col gap-6 self-start lg:col-span-4">
          <span aria-hidden className="absolute top-3 bottom-8 left-[9px] w-px bg-line" />
          {steps.map((s) => (
            <li key={s.k} className="relative flex gap-4">
              <span className={`relative z-10 mt-0.5 flex size-[19px] shrink-0 items-center justify-center rounded-full ${s.done ? "bg-night" : "border-2 border-line bg-white"}`}>
                {s.done && <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 5.2 4 7.5 8.5 2.5" stroke="#FFB547" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>}
              </span>
              <div>
                <div className={`font-bold ${s.done ? "text-ink" : "text-muted"}`}>{s.k}</div>
                <div className="mt-0.5 font-mono text-[12px] text-muted">{s.v}</div>
              </div>
            </li>
          ))}
        </ol>

        <div className="min-w-0 lg:col-span-8">
          <div className="grid grid-cols-[32px_1fr_56px_minmax(0,1.6fr)_96px] items-center gap-4 pb-3 font-mono text-[11px] uppercase tracking-[1.2px] text-muted max-sm:grid-cols-[32px_1fr_minmax(0,1fr)_88px]">
            <span /><span>Order</span><span className="max-sm:hidden">Side</span><span>Sealed limit</span><span className="text-right">Result</span>
          </div>
          {book.orders.map((o) => {
            const fill = book.fills[o.index] ?? 0;
            return (
              <a key={o.tx} href={explorer("tx", o.tx)} target="_blank" rel="noreferrer"
                className="grid grid-cols-[32px_1fr_56px_minmax(0,1.6fr)_96px] items-center gap-4 border-t border-line py-3 transition-colors hover:bg-page max-sm:grid-cols-[32px_1fr_minmax(0,1fr)_88px]">
                <Lock />
                <span className="font-bold">Order {o.index + 1}</span>
                <span className="max-sm:hidden"><span className="rounded-full px-2 py-0.5 text-xs font-bold text-night" style={{ background: o.side === "buy" ? BUY : SELL }}>{o.side}</span></span>
                <span className="truncate font-mono text-[13px] text-indigo">{groups(o.encryptedPrice, 2)} …</span>
                <span className="text-right">
                  {!cleared ? <span className="rounded-full bg-[#ECEAFF] px-2.5 py-1 text-xs font-bold text-indigo-deep">sealed</span>
                    : fill > 0 ? <span className="tnum rounded-full bg-night px-2.5 py-1 text-xs font-bold text-amber">{shares(fill)} filled</span>
                    : <span className="rounded-full bg-page px-2.5 py-1 text-xs font-bold text-body">refunded</span>}
                </span>
              </a>
            );
          })}

          {cleared && (
            <div className="mt-6 rounded-2xl bg-page p-5">
              <div className="mb-4 flex flex-wrap justify-between gap-2 font-mono text-[11px] uppercase tracking-[1.2px] text-muted">
                <span className="text-ink">How it matched</span><span>every fill at {usd(book.clearingPrice!)}</span>
              </div>
              {(["buy", "sell"] as const).map((side) => {
                const legs = book.orders.filter((o) => o.side === side && (book.fills[o.index] ?? 0) > 0);
                const total = legs.reduce((a, o) => a + book.fills[o.index], 0);
                return (
                  <div key={side} className="mb-2 flex items-center gap-3 last:mb-0">
                    <span className="w-14 shrink-0 text-sm text-body">{side === "buy" ? "Bought" : "Sold"}</span>
                    <div className="flex h-8 flex-1 gap-1">
                      {legs.map((o) => (
                        <span key={o.index} className="flex items-center justify-center rounded-lg font-mono text-xs font-bold text-night" style={{ flex: book.fills[o.index], background: side === "buy" ? BUY : SELL }}>#{o.index + 1}</span>
                      ))}
                    </div>
                    <span className="tnum w-20 shrink-0 text-right font-bold">{shares(total)} shares</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
