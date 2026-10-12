"use client";
// The order panel from the auction screen. Sealing is real (Arcium key on devnet);
// submitting needs a wallet, which is the next build.
import { useEffect, useRef, useState } from "react";
import { BUY, SELL, CipherRow, SealBadge, useMarket, useSealed } from "../Sealed";
import { usd } from "@/lib/format";
import { DemoTag } from "./NextAuction";
import { hh, nextAuction, useClock } from "./clock";

const FEE = 0.0005;

function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.5" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export default function OrderPanel({ bandBps }: { bandBps: number }) {
  const { market } = useMarket();
  const [side, setSide] = useState<"buy" | "sell">("sell");
  const [limit, setLimit] = useState("");
  const [shares, setShares] = useState("1110");
  const [showSize, setShowSize] = useState(true);
  const [sealed, setSealed] = useState(false);
  const clock = useClock(30_000);
  const hour = clock ? nextAuction(clock.ms).hour : null;
  const touched = useRef(false);

  useEffect(() => {
    if (!touched.current && market?.tsla) setLimit(market.tsla.price.toFixed(2));
  }, [market?.tsla?.price]);

  const price = parseFloat(limit);
  const qty = Math.floor(parseFloat(shares.replace(/,/g, "")));
  const valid = price > 0 && qty > 0;
  const cipher = useSealed(market?.mxeKey, side === "buy" ? BUY : SELL, price, qty);
  const pyth = market?.tsla?.price;
  const lo = pyth ? pyth * (1 - bandBps / 1e4) : null, hi = pyth ? pyth * (1 + bandBps / 1e4) : null;
  const notional = valid ? price * qty : 0;
  const outside = valid && lo !== null && hi !== null && (price < lo || price > hi);
  const edit = (f: () => void) => { f(); setSealed(false); };
  const sizeLabel = notional >= 1000 ? `$${Math.round(notional / 1000)}K` : usd(notional);

  return (
    <aside id="ticket" aria-label="Seal an order" className="flex min-w-[300px] flex-[1_1_380px] scroll-mt-6 flex-col gap-[18px] self-start rounded-3xl border border-line bg-white p-6 sm:p-7">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-extrabold">Seal an order</h2>
        <span className="rounded-full bg-[#ECEAFF] px-2.5 py-1 text-[13px] font-bold text-indigo-deep">{hour !== null ? `${hh(hour)} ET auction` : "next auction"}</span>
      </div>

      <div role="group" aria-label="Side" className="flex rounded-[14px] bg-page p-1">
        {(["buy", "sell"] as const).map((s) => (
          <button key={s} type="button" aria-pressed={side === s} onClick={() => edit(() => setSide(s))}
            className={`flex-1 rounded-[10px] p-3 text-[15px] capitalize ${side === s ? "bg-white font-extrabold text-ink shadow-[0_1px_3px_rgba(20,22,46,0.12)]" : "font-bold text-muted"}`}>
            {s}
          </button>
        ))}
      </div>

      <div className="flex gap-3">
        <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-[13px] font-bold text-body">Limit price
          <input inputMode="decimal" value={limit ? `$${limit}` : ""} onChange={(e) => edit(() => { touched.current = true; setLimit(e.target.value.replace(/[^0-9.]/g, "")); })}
            className={`min-w-0 rounded-xl border-2 px-3.5 py-3 text-[17px] font-bold text-ink outline-none ${outside ? "border-[#D9480F]" : "border-indigo"}`} />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-[13px] font-bold text-body">Shares
          <input inputMode="numeric" value={shares ? Number(shares.replace(/,/g, "") || 0).toLocaleString() : ""} onChange={(e) => edit(() => setShares(e.target.value.replace(/[^0-9]/g, "")))}
            className="min-w-0 rounded-xl border border-[#D9DAE4] px-3.5 py-3 text-[17px] font-bold text-ink outline-none focus:border-indigo" />
        </label>
      </div>
      {outside && <span className="-mt-2 text-sm font-semibold text-[#D9480F]">Outside the allowed band: this order cannot fill.</span>}

      <div className="flex flex-col gap-2.5 rounded-[14px] bg-night p-4 text-[#F7F7FA]">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-bold text-amber">What Solana sees</span>
          <SealBadge tone="dark" stamp={valid ? cipher?.price : undefined} />
        </div>
        <CipherRow label="limit" hex={valid ? cipher?.price : undefined} />
        <div className="flex justify-between text-[13px]"><span className="text-haze">side, max size</span><span className="font-bold">{valid ? `${side === "buy" ? "Buy" : "Sell"}, ${sizeLabel}` : "—"}</span></div>
      </div>

      <div className="flex flex-col gap-2.5 text-sm">
        <div className="flex justify-between"><span className="text-muted">Fee, 0.05%</span><span className="font-bold">{valid ? usd(notional * FEE) : "—"}</span></div>
        <div className="flex justify-between"><span className="text-muted">Allowed price band</span><span className="font-bold">{lo && hi ? `${usd(lo)} to ${usd(hi)}` : "—"}</span></div>
        <div className="flex justify-between"><span className="text-muted">If not fully filled</span><span className="font-bold">Rest returned</span></div>
        <div className="flex items-center justify-between">
          <span className="text-muted">Show my size to market makers</span>
          <button type="button" role="switch" aria-checked={showSize} onClick={() => setShowSize((v) => !v)} className="flex items-center gap-2 font-bold text-indigo-deep">
            <span className={`flex h-6 w-10 items-center rounded-xl p-[3px] transition-colors ${showSize ? "justify-end bg-indigo" : "justify-start bg-[#D9DAE4]"}`}>
              <span className="size-[18px] rounded-full bg-white" />
            </span>
            {showSize ? "On" : "Off"}
          </button>
        </div>
      </div>

      <button type="button" disabled={!valid || !cipher || outside} onClick={() => setSealed(true)}
        className="flex items-center justify-center gap-2.5 rounded-[14px] bg-indigo p-4 text-[17px] font-extrabold text-white transition hover:bg-indigo-deep disabled:cursor-not-allowed disabled:opacity-50">
        <LockIcon /> {sealed ? "Sealed" : "Seal order"}
      </button>
      {sealed ? (
        <span className="-mt-1 rounded-xl bg-page p-3 text-[13px] text-body">Sealed on this device. Submitting from a wallet is the next build; devnet batches run from the demo script today.</span>
      ) : (
        <span className="-mt-1 text-center text-[13px] text-muted">Encrypted on this device. Matched by Arcium.</span>
      )}

      <div className="flex flex-col gap-2.5 border-t border-line pt-1">
        <span className="flex items-center gap-2 pt-3.5 text-[13px] font-extrabold uppercase tracking-[1.2px] text-muted">Your fills tonight <DemoTag /></span>
        {[["02:00 · Buy 240 TSLAx", "$381.30"], ["03:00 · Sell 1,010 TSLAx", "$381.92"]].map(([k, v]) => (
          <div key={k} className="flex items-center justify-between text-sm">
            <span>{k}</span>
            <span className="flex items-center gap-2"><b>{v}</b><span className="rounded-full bg-[#ECEAFF] px-2 py-0.5 text-xs font-bold text-indigo-deep">Filled</span></span>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1.5 rounded-[14px] bg-[#FFF4E0] p-4">
        <span className="text-[13px] font-extrabold text-[#8A4B00]">Same order, sliced on Raydium</span>
        <span className="text-sm text-[#5C3A00]">On Tue 6 Oct it cost a seller <b>$1,931</b> against the fair price.</span>
      </div>
    </aside>
  );
}
