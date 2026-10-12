"use client";
// A tape of orders being sealed in this browser, to the Arcium key on devnet.
// The orders are random; the ciphertext is real. This is what Solana sees.
import { useEffect, useRef, useState } from "react";
import { useMarket } from "../Sealed";
import { groups, toHex } from "@/lib/format";

type Row = { id: number; t: string; side: string; limit: string; size: string };
const MAX = 16;

export default function Tape() {
  const { market } = useMarket();
  const [rows, setRows] = useState<Row[]>([]);
  const n = useRef(400);
  const mxe = market?.mxeKey, px = market?.tsla?.price ?? 378;

  useEffect(() => {
    if (!mxe) return;
    let live = true, timer = 0 as unknown as ReturnType<typeof setTimeout>;
    import("@arcium-hq/client").then(({ x25519, RescueCipher }) => {
      const key = Uint8Array.from(mxe.match(/../g)!.map((h) => parseInt(h, 16)));
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      const tick = () => {
        if (!live) return;
        const secret = x25519.utils.randomSecretKey();
        const rc = new RescueCipher(x25519.getSharedSecret(secret, key));
        const side = Math.random() < 0.5 ? 1 : 0;
        const limit = Math.round((px * (1 + (Math.random() - 0.5) * 0.02)) * 1e6);
        const qty = 1 + Math.floor(Math.random() ** 3 * 1200);
        const [s, p, q] = rc.encrypt([BigInt(side), BigInt(limit), BigInt(qty)], crypto.getRandomValues(new Uint8Array(16)));
        const t = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
        setRows((r) => [{ id: n.current++, t, side: toHex(s).slice(0, 8), limit: groups(toHex(p).slice(0, 24), 8), size: toHex(q).slice(0, 16) }, ...r].slice(0, MAX));
        timer = setTimeout(tick, reduced ? 2500 : 380 + Math.random() * 520);
      };
      tick();
    });
    return () => { live = false; clearTimeout(timer); };
  }, [mxe, px]);

  return (
    <div aria-label="Live tape of orders being encrypted in your browser" className="tape tnum relative h-full overflow-hidden font-mono text-[12.5px] leading-[32px]">
      <div className="flex items-center justify-between border-b border-white/10 pb-2 text-[11px] uppercase tracking-[1.5px] text-haze">
        <span>What Solana sees</span>
        <span className="flex items-center gap-2 whitespace-nowrap"><span className="size-1.5 animate-pulse rounded-full bg-amber" />live, your browser</span>
      </div>
      {rows.length === 0 && <div className="pt-3 text-haze">waiting for the Arcium key on devnet…</div>}
      {rows.map((r, i) => (
        <div key={r.id} className={`${i === 0 ? "tape-new " : ""}grid grid-cols-[70px_54px_1fr_auto] gap-3 border-b border-white/[0.06] whitespace-nowrap`} style={{ opacity: Math.max(0.12, 1 - i * 0.06) }}>
          <span className="text-haze">{r.t}</span>
          <span className="text-white/40">#{String(r.id).padStart(4, "0")}</span>
          <span className="truncate text-[#F7F7FA]">{r.side} {r.limit} {r.size}</span>
          <span className={`flex items-center gap-1.5 text-[11px] tracking-[1px] ${i === 0 ? "text-amber" : "text-white/30"}`}><svg width="9" height="10" viewBox="0 0 12 14" aria-hidden="true"><path d="M3 6V4a3 3 0 0 1 6 0v2" stroke="currentColor" strokeWidth="1.8" fill="none" /><rect x="1" y="6" width="10" height="7.5" rx="2" fill="currentColor" /></svg>SEALED</span>
        </div>
      ))}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-night to-transparent" />
    </div>
  );
}
