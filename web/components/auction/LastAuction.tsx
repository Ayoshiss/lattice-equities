// The last real batch cleared on devnet: one price, matched volume, Pyth at the clear,
// and the band. The crossing curves are an illustration: limits stay sealed, so the
// real book can't be drawn.
import type { BookDetail } from "@/lib/chain";
import { ago, explorer, short, usd } from "@/lib/format";

export default function LastAuction({ book, now }: { book: BookDetail | null; now: number }) {
  if (!book || book.status !== "cleared") {
    return (
      <section aria-label="Last auction" className="rounded-3xl border border-line bg-white px-8 py-7">
        <span className="text-[13px] font-extrabold uppercase tracking-[1.6px] text-indigo">Last auction</span>
        <p className="mt-2 text-body">No batch has cleared on devnet yet.</p>
      </section>
    );
  }
  const shares = book.matchedLots * book.sharesPerLot;
  const pyth = (book.bandLo! + book.bandHi!) / 2;
  const when = book.clear?.time ? new Date(book.clear.time * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }) : null;

  return (
    <section aria-label="Last auction" className="flex flex-wrap items-center gap-8 rounded-3xl border border-line bg-white px-6 py-7 sm:px-8">
      <div className="flex min-w-[220px] flex-[1_1_220px] flex-col gap-2">
        <span className="text-[13px] font-extrabold uppercase tracking-[1.6px] text-indigo">
          Last auction{when ? ` · ${when} ET` : ""} · devnet
        </span>
        <span className="text-[48px] font-extrabold leading-[1.05] tracking-[-1px]">{usd(book.clearingPrice!)}</span>
        <span className="text-[15px] text-body">One price for all {book.orderCount} orders, where buying and selling meet.</span>
        <div className="mt-2 flex flex-col gap-1.5 text-sm">
          <div className="flex justify-between"><span className="text-muted">Matched</span><b>{usd(shares * book.clearingPrice!)} · {shares} shares</b></div>
          <div className="flex justify-between"><span className="text-muted">Pyth at the clear</span><b>{usd(pyth)}</b></div>
          <div className="flex justify-between"><span className="text-muted">Cleared</span><b>{book.clear?.time ? `${ago(now - book.clear.time)} ago` : "—"}</b></div>
        </div>
        <a href={explorer("address", book.address)} target="_blank" rel="noreferrer" className="mt-1 text-sm font-bold">Batch {short(book.address)} on Explorer ↗</a>
      </div>
      <div className="flex min-w-[300px] flex-[2_1_420px] flex-col gap-2.5">
        <svg viewBox="0 0 560 210" width="100%" role="img" aria-label={`Illustration: buy and sell curves cross at ${usd(book.clearingPrice!)}, inside the Pyth band`} className="block">
          <rect x="74" y="10" width="413" height="186" rx="8" fill="#F4F2FF" />
          <line x1="10" y1="196" x2="550" y2="196" stroke="#D9DAE4" strokeWidth="2" />
          <path d="M10 40 H110 V62 H190 V88 H278 V112 H360 V150 H460 V176 H550" fill="none" stroke="#5546FF" strokeWidth="4" strokeLinejoin="round" />
          <path d="M10 186 H140 V160 H230 V136 H278 V112 H330 V84 H430 V56 H550 V36" fill="none" stroke="#13153A" strokeWidth="4" strokeLinejoin="round" />
          <line x1="278" y1="10" x2="278" y2="196" stroke="#5546FF" strokeWidth="2" strokeDasharray="6 6" />
          <circle cx="278" cy="112" r="10" fill="#5546FF" stroke="#FFFFFF" strokeWidth="4" />
          <g transform="translate(300 40)"><rect x="0" y="-15" width="96" height="28" rx="14" fill="#13153A" /><text x="48" y="4" textAnchor="middle" fontSize="13" fontWeight="800" fill="#FFB547">{usd(book.clearingPrice!)}</text></g>
        </svg>
        <div className="flex flex-wrap justify-between gap-3 text-[13px] text-muted">
          <span className="flex items-center gap-2"><span className="h-1 w-[18px] rounded-sm bg-indigo" />Buy orders</span>
          <span className="flex items-center gap-2"><span className="h-1 w-[18px] rounded-sm bg-night" />Sell orders</span>
          <span className="flex items-center gap-2"><span className="h-3 w-[18px] rounded-[3px] border border-[#D9D5FF] bg-[#F4F2FF]" />Pyth band, {usd(book.bandLo!)} to {usd(book.bandHi!)}</span>
        </div>
        <span className="text-xs text-muted">Curves are illustrative: limits stay sealed, so nobody, including us, can draw the real book.</span>
      </div>
    </section>
  );
}
