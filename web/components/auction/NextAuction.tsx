"use client";
// The dark hero: countdown to the next scheduled auction and the live imbalance.
// The countdown is real New York time; the imbalance is demo data until the
// hourly schedule ships (deposits already make side and max size public on-chain).
import { hh, mmss, nextAuction, useClock } from "./clock";

export function DemoTag({ dark = false }: { dark?: boolean }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.8px] ${dark ? "bg-white/10 text-haze" : "bg-page text-muted"}`}>Demo data</span>
  );
}

function LockIcon({ color }: { color: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

const ROWS = [
  { side: "Sell", w: "100%", max: "170px", amount: "up to $420K" },
  { side: "Buy", w: "32%", max: "70px", amount: "up to $60K" },
  { side: "Buy", w: "14%", max: "30px", amount: "up to $25K" },
];

export default function NextAuction() {
  const ms = useClock()?.ms ?? null;
  const next = ms ? nextAuction(ms) : null;

  return (
    <section aria-label="Next auction" className="flex flex-wrap items-stretch gap-8 rounded-3xl bg-night p-6 text-[#F7F7FA] sm:p-8">
      <div className="flex min-w-[260px] flex-[1_1_280px] flex-col gap-2.5">
        <span className="text-[13px] font-extrabold uppercase tracking-[1.6px] text-amber">
          Next auction · {next ? `${hh(next.hour)} ET` : "··:·· ET"}
        </span>
        <span className="text-[64px] font-extrabold leading-none tracking-[-2px] tabular-nums sm:text-[76px]">
          {next ? (next.secs !== null ? mmss(next.secs) : hh(next.hour)) : "··:··"}
        </span>
        <span className="text-base text-[#C9CBE6]">
          {next?.secs !== null ? "until TSLAx clears. Orders stay sealed until then." : "Tonight's first auction. Orders stay sealed until it clears."}
        </span>
        <div className="mt-auto flex flex-col gap-2 pt-4">
          <div className="h-2 overflow-hidden rounded bg-[#2A2E66]">
            <div className="h-2 rounded bg-amber transition-[width] duration-1000" style={{ width: `${Math.round((next?.progress ?? 0) * 100)}%` }} />
          </div>
          <div className="flex justify-between text-[13px] text-haze"><span>Order window open</span><span>87 sealed so far</span></div>
        </div>
      </div>

      <div className="flex min-w-[260px] flex-[1_1_320px] flex-col gap-3 rounded-[18px] bg-night-2 px-6 py-5">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm font-bold">Live imbalance <DemoTag dark /></span>
          <span className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-amber px-2.5 py-1 text-xs font-bold text-night">
            <LockIcon color="#13153A" /> Prices sealed
          </span>
        </div>
        <div className="flex flex-col gap-2 text-sm">
          {ROWS.map((r, i) => (
            <div key={i} className="flex items-center gap-3">
              <span className={`w-11 font-bold ${r.side === "Sell" ? "text-[#FF8A73]" : "text-[#B9B4FF]"}`}>{r.side}</span>
              <span className={`h-2.5 rounded-md ${r.side === "Sell" ? "bg-[#FF8A73]" : "bg-[#B9B4FF]"}`} style={{ width: r.w, maxWidth: r.max }} />
              <span className="ml-auto whitespace-nowrap text-[#C9CBE6]">{r.amount}</span>
            </div>
          ))}
          <div className="flex items-center gap-3">
            <span className="w-11 font-bold text-[#B9B4FF]">Maker</span>
            <span className="font-mono text-[13px] text-haze">9f3c2a71 e04b88d2…</span>
            <span className="ml-auto whitespace-nowrap text-[#C9CBE6]">quote sealed</span>
          </div>
        </div>
        <div className="flex flex-col gap-1 border-t border-[#34386E] pt-2.5">
          <span className="text-[15px] font-extrabold text-amber">$335K more to sell · makers notified</span>
          <span className="text-[13px] text-haze">Makers see the size. Nobody sees the price.</span>
        </div>
      </div>
    </section>
  );
}
