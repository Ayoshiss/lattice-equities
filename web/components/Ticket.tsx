"use client";
// The dashboard's order ticket. Sealing is real: each change re-encrypts the
// order in this browser to the Arcium MXE key on devnet.
import { useEffect, useRef, useState } from "react";
import { BUY, SELL, CipherRow, Field, SealBadge, useMarket, useSealed } from "./Sealed";
import { amount, usd } from "@/lib/format";

export default function Ticket({ bandBps }: { bandBps: number }) {
  const { market } = useMarket();
  const [side, setSide] = useState<"buy" | "sell">("sell");
  const [limit, setLimit] = useState("");
  const [shares, setShares] = useState("1100");
  const [sealedAt, setSealedAt] = useState<number | null>(null);
  const touched = useRef(false);

  useEffect(() => {
    if (!touched.current && market?.tsla) setLimit(market.tsla.price.toFixed(2));
  }, [market?.tsla?.price]);

  const price = parseFloat(limit);
  const qty = Math.floor(parseFloat(shares));
  const valid = price > 0 && qty > 0;
  const cipher = useSealed(market?.mxeKey, side === "buy" ? BUY : SELL, price, qty);
  const notional = valid ? price * qty : 0;
  const deposit = side === "buy" ? `${amount(notional)} USDC` : `${qty.toLocaleString()} TSLAx`;
  const pyth = market?.tsla?.price;
  const off = pyth && valid ? ((price - pyth) / pyth) * 100 : null;
  const outside = off !== null && Math.abs(off) > bandBps / 100;

  return (
    <div className="card flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <span className="text-lg font-bold">Seal an order</span>
        <span className="rounded-full bg-tint px-2.5 py-1 text-xs font-bold text-indigo">TSLAx / USDC</span>
      </div>

      <div className="flex rounded-xl bg-page p-1">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            onClick={() => { setSide(s); setSealedAt(null); }}
            className={`flex-1 rounded-[9px] py-2.5 font-bold capitalize transition ${side === s ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink"}`}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Limit price" prefix="$" value={limit} onChange={(v) => { touched.current = true; setLimit(v); setSealedAt(null); }} />
        <Field label="Shares" value={shares} onChange={(v) => { setShares(v); setSealedAt(null); }} />
      </div>
      {off !== null && (
        <div className={`-mt-1 text-sm ${outside ? "font-semibold text-[#D9480F]" : "text-muted"}`}>
          {off >= 0 ? "+" : ""}{off.toFixed(2)}% vs Pyth{outside ? `, outside the ±${bandBps / 100}% band: this order cannot fill` : ""}
        </div>
      )}

      <div className="flex flex-col gap-2 rounded-2xl bg-ink p-4 text-white">
        <div className="flex items-center justify-between">
          <span className="font-bold">What Solana sees</span>
          <SealBadge tone="dark" stamp={valid ? cipher?.price : undefined} />
        </div>
        <CipherRow label="side" hex={valid ? cipher?.side : undefined} />
        <CipherRow label="limit" hex={valid ? cipher?.price : undefined} />
        <CipherRow label="size" hex={valid ? cipher?.qty : undefined} />
      </div>

      <div className="flex flex-col gap-1.5 text-sm">
        <div className="flex justify-between gap-4"><span className="text-body">Order size</span><span className="font-bold">{valid ? usd(notional) : "—"}</span></div>
        <div className="flex justify-between gap-4"><span className="text-body">Deposit, public</span><span className="font-bold">{valid ? deposit : "—"}</span></div>
        <div className="flex justify-between gap-4"><span className="text-body">Price band</span><span className="font-bold">Pyth ±{bandBps / 100}%</span></div>
        <div className="flex justify-between gap-4"><span className="text-body">Relay fee, over x402</span><span className="font-bold">$0.001</span></div>
      </div>

      <button
        disabled={!valid || !cipher}
        onClick={() => setSealedAt(Date.now())}
        className="rounded-xl bg-indigo px-5 py-3.5 font-bold text-white transition hover:bg-indigo-deep disabled:cursor-not-allowed disabled:opacity-50"
      >
        {sealedAt ? "Sealed ✓" : "Seal order"}
      </button>
      {sealedAt ? (
        <p className="-mt-1 rounded-xl bg-page p-3 text-sm text-body">
          Sealed in this browser. Sending it on-chain needs a wallet, which is the next build; devnet batches run from the demo script today.
        </p>
      ) : (
        <span className="-mt-1 text-center text-xs text-muted">Unaudited · Solana devnet · test tokens only</span>
      )}
    </div>
  );
}
