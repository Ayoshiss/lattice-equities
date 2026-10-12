"use client";
// Live strip across the top of the dashboard: Pyth TSLA price, US session, band, latest batch.
import { STALE_AFTER_SECS, until, useMarket } from "./Sealed";
import { usd } from "@/lib/format";

export default function MarketBar({ bandBps, batch }: { bandBps: number; batch: string }) {
  const { market, now } = useMarket();
  const t = market?.tsla;
  const age = t ? now - t.publishTime : null;
  const fresh = age !== null && age < STALE_AFTER_SECS;
  const s = market?.session;
  const session = !s ? "—" : s.isOpen ? `Open · closes in ${s.nextClose ? until(s.nextClose - now) : "—"}` : `Closed · opens in ${s.nextOpen ? until(s.nextOpen - now) : "—"}`;
  const cells: [string, React.ReactNode][] = [
    ["Pyth price", (
      <span className="flex items-center gap-2">
        <span className={`size-2 rounded-full ${fresh ? "bg-[#22C55E]" : "bg-[#F5A524]"}`} />
        {t ? `±${usd(t.conf)} · ${Math.max(0, Math.round(age!))}s ago` : "loading"}
      </span>
    )],
    ["Wall Street", session],
    ["Price band", `Pyth ±${bandBps / 100}%`],
    ["Latest batch", batch],
  ];
  return (
    <div className="card flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:gap-10">
      <div className="flex items-center gap-4">
        <div className="flex size-11 items-center justify-center rounded-2xl bg-ink text-sm font-bold text-lime">TSLA</div>
        <div>
          <div className="text-sm font-semibold text-muted">TSLAx / USDC</div>
          <div className="text-[28px] font-semibold leading-none tracking-[-1px]">{t ? usd(t.price) : "$ ···.··"}</div>
        </div>
      </div>
      <div className="grid flex-1 grid-cols-2 gap-x-8 gap-y-3 md:grid-cols-4">
        {cells.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-[1px] text-muted">{k}</div>
            <div className="mt-1 truncate text-sm font-bold text-ink">{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
