// Live log of cleared devnet batches, in a terminal window. Each row links to Explorer.
import type { BookDetail } from "@/lib/chain";
import { PROGRAM_ID, ago, explorer, pythDistance, short, usd } from "@/lib/format";

export default function BatchTerminal({ past, className = "" }: { past: BookDetail[]; className?: string }) {
  const nowSec = Date.now() / 1000;
  return (
    <div className={`overflow-hidden ${className} rounded-[22px] bg-night font-mono text-[13px] text-[#C9CBE6] shadow-[0_40px_80px_-40px_rgba(19,21,58,0.55)]`}>
      <div className="flex items-center justify-between gap-4 border-b border-white/10 px-6 py-3.5 text-[12px]">
        <span className="truncate"><span className="text-amber">$</span> lattice batches --network devnet</span>
        <a href={explorer("address", PROGRAM_ID)} target="_blank" rel="noreferrer" className="shrink-0 text-haze hover:text-white">program {short(PROGRAM_ID)} ↗</a>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[720px] px-6 pt-2 pb-1">
          <div className="grid grid-cols-[150px_100px_90px_70px_110px_120px_1fr] gap-4 py-3 text-[10.5px] uppercase tracking-[1.2px] text-haze/80">
            <span>batch</span><span>cleared</span><span>feed</span><span>orders</span><span>price</span><span>vs pyth</span><span className="text-right">settled</span>
          </div>
          {past.map((b, i) => {
            const d = pythDistance(b.clearingPrice!, b.bandLo!, b.bandHi!);
            const s = new Set(b.settlements.map((x) => x.slot)).size;
            return (
              <a key={b.address} href={explorer("address", b.address)} target="_blank" rel="noreferrer"
                className="group grid grid-cols-[150px_100px_90px_70px_110px_120px_1fr] items-center gap-4 border-t border-white/[0.07] py-3.5 transition-colors hover:bg-white/[0.04]">
                <span className="flex items-center gap-2 text-[#F7F7FA]">
                  {short(b.address)}
                  {i === 0 && <span className="rounded bg-amber px-1.5 py-px text-[9.5px] font-bold tracking-[1px] text-night">LATEST</span>}
                </span>
                <span className="text-haze">{b.clear?.time ? `${ago(nowSec - b.clear.time)} ago` : "—"}</span>
                <span>{b.feed}</span>
                <span>{b.orderCount}</span>
                <span className="tnum text-amber">{usd(b.clearingPrice!)}</span>
                <span className="tnum">{d.label}</span>
                <span className="flex items-center justify-end gap-2.5">
                  <span className="flex gap-1">{Array.from({ length: b.orderCount }, (_, k) => <span key={k} className={`size-1.5 rounded-full ${k < s ? "bg-[#7EE2A8]" : "bg-white/20"}`} />)}</span>
                  <span className="tnum text-[#7EE2A8]">{s}/{b.orderCount}</span>
                  <span className="text-haze transition-transform group-hover:translate-x-0.5 group-hover:text-white">↗</span>
                </span>
              </a>
            );
          })}
          {past.length === 0 && <div className="py-4">no cleared batches yet</div>}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 px-6 py-3 text-[11px] text-haze">
        <span className="flex items-center gap-2"><span className="size-1.5 animate-pulse rounded-full bg-[#7EE2A8]" />fetched live from devnet on page load</span>
        <span>unaudited · test tokens only</span>
      </div>
    </div>
  );
}
