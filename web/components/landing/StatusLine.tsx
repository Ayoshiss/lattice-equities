"use client";
// One terminal line across the top: live Pyth price, New York time, the next auction, devnet batches.
import { useMarket } from "../Sealed";
import { usd } from "@/lib/format";
import { hh, mmss, nextAuction, nyParts, useClock } from "../auction/clock";

export default function StatusLine({ batches }: { batches: number }) {
  const { market, now } = useMarket();
  const clock = useClock();
  const t = market?.tsla;
  const age = t ? Math.max(0, Math.round(now - t.publishTime)) : null;
  const ny = clock ? nyParts(clock.ms) : null;
  const next = clock ? nextAuction(clock.ms) : null;
  const cells = [
    ["TSLA", t ? usd(t.price) : "···", age !== null ? `pyth ${age}s` : ""],
    ["NEW YORK", ny ? `${String(ny.h).padStart(2, "0")}:${String(ny.m).padStart(2, "0")}:${String(ny.s).padStart(2, "0")}` : "··:··", clock?.demo ? "demo clock" : ""],
    ["NEXT AUCTION", next ? hh(next.hour) : "··:··", next?.secs != null ? `in ${mmss(next.secs)}` : "tonight"],
    ["DEVNET", `${batches} cleared`, "batches"],
  ];
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-1 border-b border-white/10 py-3 font-mono text-[12px] tracking-[0.5px]">
      {cells.map(([k, v, s], i) => (
        <span key={k} className={`flex gap-2 ${i > 1 ? "max-sm:hidden" : ""}`}>
          <span className="text-haze">{k}</span>
          <span className="text-[#F7F7FA]">{v}</span>
          {s && <span className="text-amber">{s}</span>}
        </span>
      ))}
    </div>
  );
}
