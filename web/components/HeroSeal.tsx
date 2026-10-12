"use client";
// The landing page's live card: real orders, sealed in this browser to the
// Arcium key on devnet, cycling every few seconds so the ciphertext keeps landing.
import { useEffect, useState } from "react";
import { BUY, SELL, CipherRow, SealBadge, useMarket, useSealed } from "./Sealed";
import { usd } from "@/lib/format";

const ORDERS = [
  { side: "sell", shares: 1100, offset: 0 },
  { side: "buy", shares: 240, offset: -0.4 },
  { side: "buy", shares: 65, offset: -0.9 },
  { side: "sell", shares: 410, offset: 0.6 },
] as const;

export default function HeroSeal() {
  const { market, now } = useMarket();
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % ORDERS.length), 3200);
    return () => clearInterval(t);
  }, []);
  const o = ORDERS[i];
  const px = market?.tsla?.price ?? 0;
  const limit = px ? Math.round((px + o.offset) * 100) / 100 : 0;
  const cipher = useSealed(market?.mxeKey, o.side === "buy" ? BUY : SELL, limit, o.shares);
  const age = market?.tsla ? Math.max(0, Math.round(now - market.tsla.publishTime)) : null;

  return (
    <div className="relative w-full max-w-[460px]">
      <div className="pointer-events-none absolute -inset-10 rounded-full bg-indigo/35 blur-3xl" />
      <div className="relative rounded-3xl border border-white/10 bg-white p-6 shadow-[0_30px_80px_rgba(0,0,0,0.35)]">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-muted">TSLAx · Pyth price</div>
            <div className="mt-1 text-[34px] font-extrabold leading-none tracking-[-1px] text-ink">{px ? usd(px) : "$ ···.··"}</div>
          </div>
          <span className="flex items-center gap-2 rounded-full bg-page px-3 py-1.5 text-xs font-bold text-body">
            <span className={`size-2 rounded-full ${age !== null && age < 120 ? "bg-[#22C55E]" : "bg-[#F5A524]"}`} />
            {age !== null ? `${age}s ago` : "loading"}
          </span>
        </div>

        <div className="mt-5 rounded-2xl border border-line p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold text-muted">Order {i + 1} of the batch</span>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${o.side === "buy" ? "bg-[#B9B4FF] text-night" : "bg-[#FF8A73] text-night"}`}>{o.side}</span>
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="text-xl font-bold text-ink">{o.shares.toLocaleString()} TSLAx</span>
            <span className="font-semibold text-body">limit {limit ? usd(limit) : "—"}</span>
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-2 rounded-[14px] bg-night p-5 text-[#F7F7FA]">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-bold text-amber">What Solana sees</span>
            <SealBadge tone="dark" stamp={cipher?.price} />
          </div>
          <CipherRow label="side" hex={cipher?.side} />
          <CipherRow label="limit" hex={cipher?.price} />
          <CipherRow label="size" hex={cipher?.qty} />
        </div>
        <p className="mt-4 text-center text-xs text-muted">Encrypted live in your browser to the Arcium key on Solana devnet.</p>
      </div>
    </div>
  );
}
