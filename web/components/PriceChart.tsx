"use client";
// Ticket header and TSLA chart from Pyth's history API, with past Lattice
// clears marked on it. Hovering shows that moment's price in the header.
import { useEffect, useMemo, useRef, useState } from "react";
import type { History, Range } from "@/lib/market";
import { usd } from "@/lib/format";

const RANGES: Range[] = ["1D", "1W", "1M"];
const LABEL: Record<Range, string> = { "1D": "today", "1W": "past week", "1M": "past month" };
const W = 400, H = 80, PAD_Y = 6, PAD_R = 8; // viewBox units; the SVG stretches to the card width

export type Clear = { time: number; price: number };

const et = (t: number, range: Range) =>
  new Date(t * 1000).toLocaleString("en-US", {
    timeZone: "America/New_York",
    ...(range === "1D" ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric" }),
  }) + " ET";

export default function PriceChart({ live, clears }: { live: number | null; clears: Clear[] }) {
  const [range, setRange] = useState<Range>("1D");
  const [data, setData] = useState<Partial<Record<Range, History | null>>>({});
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (data[range] !== undefined) return;
    fetch(`/api/history?range=${range}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((h) => setData((d) => ({ ...d, [range]: h?.t?.length ? h : null })))
      .catch(() => setData((d) => ({ ...d, [range]: null })));
  }, [range, data]);

  const h = data[range];
  const geo = useMemo(() => {
    if (!h) return null;
    const t0 = h.t[0], t1 = h.t[h.t.length - 1];
    const lo = Math.min(...h.c), hi = Math.max(...h.c);
    const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * (W - PAD_R);
    const y = (p: number) => PAD_Y + (1 - (p - lo) / (hi - lo || 1)) * (H - 2 * PAD_Y);
    const line = h.c.map((p, i) => `${i ? "L" : "M"}${x(h.t[i]).toFixed(1)},${y(p).toFixed(1)}`).join("");
    // A clear newer than the last candle still belongs at the live end of the line.
    const dots = clears
      .filter((c) => c.time >= t0 && c.time <= Date.now() / 1000 && c.price >= lo && c.price <= hi)
      .map((c) => ({ ...c, at: Math.min(c.time, t1) }));
    return { x, y, line, area: `${line}L${x(t1)},${H}L0,${H}Z`, open: y(h.c[0]), dots };
  }, [h, clears]);

  const shown = hover !== null && h ? h.c[hover] : live ?? h?.c[h.c.length - 1] ?? null;
  const change = h && shown !== null ? ((shown - h.c[0]) / h.c[0]) * 100 : null;
  const up = (change ?? 0) >= 0;
  const i = hover ?? (h ? h.c.length - 1 : 0);

  function onMove(e: React.PointerEvent) {
    if (!h || !box.current) return;
    const r = box.current.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width * (1 - PAD_R / W))));
    const t = h.t[0] + f * (h.t[h.t.length - 1] - h.t[0]);
    let best = 0;
    for (let k = 1; k < h.t.length; k++) if (Math.abs(h.t[k] - t) < Math.abs(h.t[best] - t)) best = k;
    setHover(best);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-muted">TSLA / USDC</div>
          <div className="text-[28px] font-bold leading-tight tracking-[-0.5px]">{shown !== null ? usd(shown) : "—"}</div>
          <div className="truncate text-sm">
            {change !== null ? (
              <>
                <span className={`font-bold ${up ? "text-[#16A34A]" : "text-[#DC2626]"}`}>
                  {up ? "+" : ""}{change.toFixed(2)}%
                </span>
                <span className="text-muted"> {hover !== null ? et(h!.t[hover], range) : LABEL[range]}</span>
              </>
            ) : (
              <span className="text-muted">{h === null ? "Price history unavailable" : "Loading price history"}</span>
            )}
          </div>
        </div>
        <span className="flex shrink-0 rounded-lg bg-page p-0.5">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => { setRange(r); setHover(null); }}
              className={`rounded-md px-2.5 py-1 text-xs font-bold ${r === range ? "bg-white text-ink shadow-sm" : "text-muted"}`}
            >
              {r}
            </button>
          ))}
        </span>
      </div>

      <div
        ref={box}
        className="relative h-20 touch-none select-none"
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {geo && (
          <>
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
              <defs>
                <linearGradient id="px-fill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#5546FF" stopOpacity="0.14" />
                  <stop offset="100%" stopColor="#5546FF" stopOpacity="0" />
                </linearGradient>
              </defs>
              <line x1="0" x2={W} y1={geo.open} y2={geo.open} stroke="#6E7189" strokeOpacity="0.45" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
              <path d={geo.area} fill="url(#px-fill)" />
              <path d={geo.line} fill="none" stroke="#5546FF" strokeWidth="1.75" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
              {hover !== null && (
                <line x1={geo.x(h!.t[i])} x2={geo.x(h!.t[i])} y1="0" y2={H} stroke="#0E1030" strokeOpacity="0.2" vectorEffect="non-scaling-stroke" />
              )}
            </svg>
            {geo.dots.map((c) => (
              <span
                key={c.time}
                title={`Lattice batch cleared at ${usd(c.price)}`}
                className="absolute size-2.5 -translate-1/2 rounded-full border-2 border-white bg-lime shadow"
                style={{ left: `${(geo.x(c.at) / W) * 100}%`, top: `${(geo.y(c.price) / H) * 100}%` }}
              />
            ))}
            <span
              className="pointer-events-none absolute size-2 -translate-1/2 rounded-full bg-indigo ring-4 ring-indigo/15"
              style={{ left: `${(geo.x(h!.t[i]) / W) * 100}%`, top: `${(geo.y(h!.c[i]) / H) * 100}%` }}
            />
          </>
        )}
      </div>
    </div>
  );
}
