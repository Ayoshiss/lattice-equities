"use client";
// Tonight's hourly TSLAx auctions. The schedule is the plan (9pm to 4am ET, Sun to Thu);
// the per-hour results are demo data until it ships.
import { DemoTag } from "./NextAuction";
import { SCHEDULE, hh, nextAuction, useClock } from "./clock";

const DEMO = [["$380.12", 44], ["$379.40", 52], ["$380.84", 38], ["$381.10", 47], ["$380.95", 41], ["$381.30", 55], ["$381.92", 61]] as const;

export default function Tonight() {
  const ms = useClock(30_000)?.ms ?? null;
  const nextHour = ms ? nextAuction(ms).hour : 4;
  const nextIdx = Math.max(0, SCHEDULE.indexOf(nextHour));

  return (
    <section id="auctions" aria-label="Tonight's auctions" className="flex scroll-mt-6 flex-col gap-5 rounded-3xl border border-line bg-white px-6 py-7 sm:px-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="flex items-center gap-2.5 text-xl font-extrabold">Tonight, TSLAx <DemoTag /></h2>
        <span className="text-sm text-muted">One auction an hour, 9pm to 4am ET, Sun to Thu</span>
      </div>
      <div className="-mx-6 flex gap-2 overflow-x-auto px-6 pb-1 sm:mx-0 sm:px-0 md:grid md:grid-cols-8 md:overflow-visible">
        {SCHEDULE.map((h, i) => {
          const isNext = i === nextIdx;
          const done = i < nextIdx && DEMO[i];
          return (
            <div key={h} className={`flex min-w-[104px] shrink-0 flex-col gap-1 rounded-[14px] p-3 md:min-w-0 ${isNext ? "bg-indigo text-[#F7F7FA]" : "bg-page"}`}>
              <span className={`text-[13px] ${isNext ? "text-[#E6E3FF]" : "text-muted"}`}>{hh(h)}{isNext ? " next" : ""}</span>
              <span className="text-[17px] font-extrabold">{isNext ? "Sealed" : done ? DEMO[i][0] : "—"}</span>
              <span className={`text-xs ${isNext ? "text-[#E6E3FF]" : "text-muted"}`}>{isNext ? "87 orders" : done ? `${DEMO[i][1]} orders` : "upcoming"}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
