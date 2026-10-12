"use client";
// The most recent real batch on devnet. Polls so a run started from the demo
// script shows up here as it happens: orders sealing, the clear, the payouts.
import { useEffect, useState } from "react";
import type { BookDetail, BookSummary } from "@/lib/chain";
import { ago, explorer, groups, pythDistance, short, usd } from "@/lib/format";

const POLL_MS = 10_000;

function latestWithOrders(books: BookSummary[]) {
  return books.find((b) => b.orderCount > 0) ?? null;
}

function Lock() {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-tint">
      <svg width="14" height="16" viewBox="0 0 14 16" fill="none" aria-hidden>
        <path d="M3.5 7V4.5a3.5 3.5 0 0 1 7 0V7" stroke="#5546FF" strokeWidth="2" />
        <rect x="1" y="7" width="12" height="8" rx="2" fill="#5546FF" />
      </svg>
    </span>
  );
}

function Step({ done, fraction = 1, title, sub }: { done: boolean; fraction?: number; title: string; sub: string }) {
  const pct = done ? 100 : Math.round(fraction * 100);
  return (
    <div>
      <div className="h-1 rounded-sm" style={{ background: `linear-gradient(90deg, #5546FF ${pct}%, #E4E4EE ${pct}%)` }} />
      <div className={`mt-3 font-bold ${pct === 0 ? "text-muted" : ""}`}>{title}</div>
      <div className="text-sm text-muted">{sub}</div>
    </div>
  );
}

function headline(b: BookDetail) {
  if (b.status === "cleared") return `Batch ${short(b.address)} cleared at ${usd(b.clearingPrice!)}.`;
  if (b.status === "clearing") return `Batch ${short(b.address)} is clearing in Arcium.`;
  if (b.status === "dead") return `Batch ${short(b.address)} was released and refunded.`;
  return `${b.orderCount} order${b.orderCount === 1 ? "" : "s"} sealed, waiting to clear.`;
}

export default function LiveAuction({ initial, now: serverNow }: { initial: BookDetail | null; now: number }) {
  const [book, setBook] = useState(initial);
  const [now, setNow] = useState(serverNow);

  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const books: BookSummary[] = await fetch("/api/books").then((r) => r.json());
        const top = latestWithOrders(books);
        if (!top) return;
        const detail: BookDetail = await fetch(`/api/books/${top.address}`).then((r) => r.json());
        if (live && detail?.address) setBook(detail);
      } catch {}
      if (live) setNow(Date.now() / 1000);
    };
    const t = setInterval(poll, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, []);

  if (!book) {
    return (
      <section id="auction" className="mt-24 scroll-mt-8">
        <div className="text-sm font-semibold text-indigo">Latest auction</div>
        <h2 className="mt-2 text-[32px] font-semibold leading-tight tracking-[-1px]">No batch on devnet yet.</h2>
      </section>
    );
  }

  const n = book.orderCount;
  const times = book.orders.map((o) => o.time).filter((t): t is number => t !== null);
  const firstAt = Math.min(...times), lastAt = Math.max(...times);
  const cleared = book.status === "cleared";
  const settledSlots = new Set(book.settlements.map((s) => s.slot));
  const lastEvent = book.timeline.at(-1)?.time ?? lastAt;
  const dist = cleared && book.bandLo && book.bandHi ? pythDistance(book.clearingPrice!, book.bandLo, book.bandHi) : null;
  const marker = dist ? Math.min(1, Math.max(0, (book.clearingPrice! - book.bandLo!) / (book.bandHi! - book.bandLo!))) : 0.5;
  const shares = (lots: number) => lots * book.sharesPerLot;

  return (
    <section id="auction" className="mt-24 scroll-mt-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div>
          <div className="text-sm font-semibold text-indigo">Latest auction</div>
          <h2 className="mt-2 text-[28px] font-semibold leading-tight tracking-[-1px] sm:text-[32px]">{headline(book)}</h2>
        </div>
        <span className="text-body">
          {cleared ? "Cleared" : "Last activity"} <b className="text-ink">{ago(now - lastEvent)} ago</b> on devnet
        </span>
      </div>

      <div className="card mt-8 flex flex-col gap-8 p-5 sm:p-8">
        <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
          <Step done title={`${n} order${n === 1 ? "" : "s"} sealed`} sub={times.length > 1 ? `over ${lastAt - firstAt}s` : "encrypted in the browser"} />
          <Step done={cleared} fraction={0} title="Fresh Pyth price" sub={cleared ? `${book.feed}, checked on-chain${book.clear?.usedFallback ? ", fallback feed" : ""}` : "checked at the clear"} />
          <Step
            done={cleared}
            fraction={0}
            title="Cleared in Arcium"
            sub={cleared && book.clear?.time ? `in ${book.clear.time - lastAt}s, nothing decrypted` : "nothing decrypted"}
          />
          <Step
            done={cleared && settledSlots.size === n}
            fraction={cleared ? settledSlots.size / n : 0}
            title={settledSlots.size === n && cleared ? "Settled" : "Settling"}
            sub={`${settledSlots.size} of ${n} paid out`}
          />
        </div>

        <div className="grid gap-8 lg:grid-cols-12 lg:gap-6">
          <div className="min-w-0 lg:col-span-7">
            <div className="grid grid-cols-[32px_auto_minmax(0,1fr)_auto] items-center gap-3 pb-3.5 text-sm font-semibold text-muted sm:grid-cols-[32px_1fr_64px_1.6fr_112px] sm:gap-4">
              <span />
              <span>Order</span>
              <span className="hidden sm:block">Side</span>
              <span>Sealed limit</span>
              <span className="text-right">Result</span>
            </div>
            {book.orders.map((o) => {
              const fill = book.fills[o.index] ?? 0;
              return (
                <a
                  key={o.tx}
                  href={explorer("tx", o.tx)}
                  target="_blank"
                  rel="noreferrer"
                  className="grid grid-cols-[32px_auto_minmax(0,1fr)_auto] items-center gap-3 border-t border-line py-3.5 hover:bg-[#F7F6FF] sm:grid-cols-[32px_1fr_64px_1.6fr_112px] sm:gap-4"
                >
                  <Lock />
                  <span className="whitespace-nowrap font-bold">Order {o.index + 1}</span>
                  <span className="hidden text-body sm:block">{o.side}</span>
                  <span className="truncate font-mono text-sm text-indigo">{groups(o.encryptedPrice, 2)} …</span>
                  <span className="text-right">
                    {!cleared ? (
                      <span className="rounded-full bg-tint px-3 py-1 text-sm font-bold text-indigo">sealed</span>
                    ) : fill > 0 ? (
                      <span className={`whitespace-nowrap rounded-full px-3 py-1 text-sm font-bold text-ink ${o.side === "buy" ? "bg-lime" : "bg-[#8F86FF]"}`}>{shares(fill)} filled</span>
                    ) : (
                      <span className="rounded-full bg-page px-3 py-1 text-sm font-bold text-body">refunded</span>
                    )}
                  </span>
                </a>
              );
            })}

            {cleared && (
              <div className="mt-6 rounded-2xl bg-page p-5">
                <div className="mb-3 flex flex-wrap justify-between gap-x-4 text-sm text-body">
                  <span className="font-semibold text-ink">How it matched</span>
                  <span>every fill at {usd(book.clearingPrice!)}</span>
                </div>
                {(["buy", "sell"] as const).map((side) => {
                  const legs = book.orders.filter((o) => o.side === side && (book.fills[o.index] ?? 0) > 0);
                  const total = legs.reduce((a, o) => a + book.fills[o.index], 0);
                  return (
                    <div key={side} className="mb-2 flex items-center gap-3 last:mb-0">
                      <span className="w-12 shrink-0 text-sm text-body">{side === "buy" ? "Bought" : "Sold"}</span>
                      <div className="flex h-7 flex-1 gap-1">
                        {legs.map((o) => (
                          <span
                            key={o.index}
                            className={`flex items-center justify-center rounded-md text-xs font-bold ${side === "buy" ? "bg-lime text-ink" : "bg-[#8F86FF] text-ink"}`}
                            style={{ flex: book.fills[o.index] }}
                            title={`Order ${o.index + 1}: ${shares(book.fills[o.index])} shares`}
                          >
                            #{o.index + 1}
                          </span>
                        ))}
                      </div>
                      <span className="w-20 shrink-0 text-right font-bold">{shares(total)} shares</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="relative flex flex-col gap-6 overflow-hidden rounded-2xl bg-tint p-6 text-ink lg:col-span-5">
            <div className="pointer-events-none absolute -top-24 -right-24 size-64 rounded-full bg-white/70 blur-3xl" />

            <div className="relative">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-indigo">Clearing price</span>
                {cleared ? (
                  <span className="rounded-full bg-lime px-2.5 py-0.5 text-xs font-bold text-ink">Cleared</span>
                ) : (
                  <span className="rounded-full bg-white px-2.5 py-0.5 text-xs font-bold text-indigo">Sealed</span>
                )}
              </div>
              <div className="mt-2 text-[52px] font-semibold leading-none tracking-[-2px]">
                {cleared ? usd(book.clearingPrice!) : "$ ••••••"}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                {dist && (
                  <span className="rounded-full bg-indigo px-2.5 py-0.5 font-bold text-white">
                    {dist.pct < 0 ? "▼" : "▲"} {dist.label} Pyth
                  </span>
                )}
                <span className="text-body">{cleared ? "one price for every fill" : "revealed only when the batch clears"}</span>
              </div>
            </div>

            {book.bandLo && book.bandHi && (
              <div className="relative">
                <div className="mb-3 flex justify-between text-sm text-body">
                  <span className="font-semibold text-ink">Allowed range</span>
                  <span>Pyth ±{book.bandBps / 100}%</span>
                </div>
                <div className="relative h-2 rounded-full bg-gradient-to-r from-indigo/20 via-indigo/60 to-indigo/20">
                  {/* the band is built around the Pyth price, so it sits in the middle */}
                  <div className="absolute -inset-y-2 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-ink/60" />
                  {cleared && (
                    <div
                      className="absolute top-1/2 size-4 -translate-1/2 rounded-full border-[3px] border-white bg-indigo shadow-[0_0_0_5px_rgba(85,70,255,0.18),0_4px_14px_rgba(85,70,255,0.55)]"
                      style={{ left: `${marker * 100}%` }}
                      title={`Cleared at ${usd(book.clearingPrice!)}`}
                    />
                  )}
                </div>
                <div className="mt-3 grid grid-cols-3 text-sm text-body">
                  <span>{usd(book.bandLo)}</span>
                  <span className="text-center font-semibold text-ink">Pyth {usd((book.bandLo + book.bandHi) / 2)}</span>
                  <span className="text-right">{usd(book.bandHi)}</span>
                </div>
              </div>
            )}

            {cleared && (
              <div className="relative mt-auto grid grid-cols-3 divide-x divide-line rounded-xl bg-white">
                {[
                  ["Volume", usd(shares(book.matchedLots) * book.clearingPrice!)],
                  ["Matched", `${shares(book.matchedLots)} shares`],
                  ["Paid out", `${settledSlots.size} of ${n}`],
                ].map(([k, v]) => (
                  <div key={k} className="min-w-0 px-3 py-3 sm:px-4">
                    <div className="whitespace-nowrap text-xs font-semibold text-muted sm:text-sm">{k}</div>
                    <div className="whitespace-nowrap text-base font-bold sm:text-lg">{v}</div>
                  </div>
                ))}
              </div>
            )}

            <div className={`relative grid grid-cols-2 gap-2 border-t border-indigo/15 pt-5 sm:grid-cols-4 ${cleared ? "" : "mt-auto"}`}>
              {[
                ["Book", explorer("address", book.address)],
                ["Order", book.orders[0] && explorer("tx", book.orders[0].tx)],
                ["Clear", book.clear && explorer("tx", book.clear.tx)],
                ["Payout", book.settlements[0] && explorer("tx", book.settlements[0].tx)],
              ]
                .filter(([, href]) => href)
                .map(([label, href]) => (
                  <a
                    key={label as string}
                    href={href as string}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg bg-white py-2 text-center text-sm font-bold whitespace-nowrap text-indigo shadow-[0_1px_2px_rgba(14,16,48,0.06)] hover:bg-indigo hover:text-white"
                  >
                    {label} ↗
                  </a>
                ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
