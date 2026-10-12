import type { BookDetail } from "@/lib/chain";
import { explorer, pythDistance, short, usd } from "@/lib/format";

// Cleared batches on devnet, newest first. Each row links to the book on Solana Explorer.
export default function PastAuctions({ past }: { past: BookDetail[] }) {
  return (
    <div className="card px-5 py-2 sm:px-6">
      <div className="hidden grid-cols-[1.3fr_1fr_0.7fr_1fr_1.3fr_1fr_90px] gap-4 py-3.5 text-sm font-semibold text-muted md:grid">
        <span>Batch</span><span>Reference</span><span>Orders</span><span>Clearing price</span><span>Distance from Pyth</span><span>Settled</span><span />
      </div>
      {past.length === 0 && <p className="py-6 text-body">No cleared batches yet.</p>}
      {past.map((b) => {
        const d = pythDistance(b.clearingPrice!, b.bandLo!, b.bandHi!);
        const settled = new Set(b.settlements.map((s) => s.slot)).size;
        return (
          <a
            key={b.address}
            href={explorer("address", b.address)}
            target="_blank"
            rel="noreferrer"
            className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-line py-4 max-md:first-of-type:border-t-0 hover:bg-[#F7F6FF] md:grid-cols-[1.3fr_1fr_0.7fr_1fr_1.3fr_1fr_90px] md:items-center md:py-3.5"
          >
            <span className="font-bold">{short(b.address)}</span>
            <span className="text-right font-bold text-indigo md:hidden">{usd(b.clearingPrice!)}</span>
            <span className="text-body">{b.feed}<span className="md:hidden">, {b.orderCount} orders</span></span>
            <span className="hidden text-body md:block">{b.orderCount}</span>
            <span className="hidden font-bold text-indigo md:block">{usd(b.clearingPrice!)}</span>
            <span className="text-right text-body md:text-left">{d.label}<span className="md:hidden"> Pyth</span></span>
            <span className="hidden md:block">
              <span className="rounded-full bg-lime px-3 py-1 text-sm font-bold">{settled} of {b.orderCount}</span>
            </span>
            <span className="hidden text-right font-bold text-indigo md:block">Explorer ↗</span>
          </a>
        );
      })}
    </div>
  );
}
