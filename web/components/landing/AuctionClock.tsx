"use client";
// The closing illustration: an hour on a dial. Orders arrive on the rim and seal,
// the hand sweeps, and at the top of the hour they all clear into one price.
import { useEffect, useState } from "react";
import { hh, mmss, nextAuction, useClock } from "../auction/clock";

const LOOP_MS = 9000;
const R = 104; // rim radius
// Arrival time (fraction of the loop) and angle of each order, fixed so it renders the same everywhere.
const ORDERS = [[0.06, 32], [0.12, 151], [0.17, 250], [0.24, 95], [0.3, 300], [0.36, 200], [0.42, 12], [0.49, 128], [0.55, 228], [0.61, 330], [0.66, 64], [0.71, 176]] as const;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp = (v: number) => Math.min(1, Math.max(0, v));
// Server and browser trig can differ in the last digits; round so hydration matches.
const f = (n: number) => Math.round(n * 100) / 100;

export default function AuctionClock() {
  const [t, setT] = useState(0.86);
  const clock = useClock();
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const start = performance.now();
    const frame = (now: number) => { setT(((now - start) % LOOP_MS) / LOOP_MS); raf = requestAnimationFrame(frame); };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const sweep = clamp(t / 0.78);            // the hour passing
  const merge = ease(clamp((t - 0.8) / 0.1)); // top of the hour: everything clears
  const reveal = clamp((t - 0.88) / 0.05) * (1 - clamp((t - 0.97) / 0.03));
  const handA = sweep * 360 - 90;
  const next = clock ? nextAuction(clock.ms) : null;

  return (
    <div className="flex flex-col items-center gap-4" aria-label="Illustration: orders arrive and seal during the hour, then clear together at one price">
      <svg viewBox="-130 -130 260 260" className="size-[clamp(200px,20vw,280px)] overflow-visible" aria-hidden="true">
        <circle r={R} fill="none" stroke="#13153A" strokeOpacity="0.18" strokeWidth="2" />
        {Array.from({ length: 12 }, (_, i) => {
          const a = (i / 12) * Math.PI * 2;
          return <line key={i} x1={f(Math.cos(a) * (R - 10))} y1={f(Math.sin(a) * (R - 10))} x2={f(Math.cos(a) * (R - (i % 3 ? 4 : 0)))} y2={f(Math.sin(a) * (R - (i % 3 ? 4 : 0)))} stroke="#13153A" strokeOpacity={i % 3 ? 0.25 : 0.6} strokeWidth="2" strokeLinecap="round" />;
        })}
        {/* the hour, filling in */}
        <circle r={R} fill="none" stroke="#13153A" strokeWidth="4" strokeLinecap="round"
          strokeDasharray={`${f(sweep * 2 * Math.PI * R)} ${f(2 * Math.PI * R)}`} transform="rotate(-90)" opacity={1 - merge} />
        <line x1="0" y1="0" x2={f(Math.cos((handA * Math.PI) / 180) * (R - 22))} y2={f(Math.sin((handA * Math.PI) / 180) * (R - 22))} stroke="#13153A" strokeWidth="4" strokeLinecap="round" opacity={1 - merge} />

        {ORDERS.map(([at, deg], i) => {
          const live = t >= at;
          const sealed = clamp((t - at - 0.04) / 0.05);
          const a = (deg * Math.PI) / 180;
          const x = f(Math.cos(a) * R * (1 - merge)), y = f(Math.sin(a) * R * (1 - merge));
          return (
            <g key={i} transform={`translate(${x} ${y})`} opacity={live ? 1 - clamp((merge - 0.85) / 0.15) : 0}>
              <circle r={7 - sealed * 1} fill={sealed > 0.5 ? "#13153A" : "#FFF4E0"} stroke="#13153A" strokeWidth="2" />
              {sealed > 0.5 && (
                <g transform="scale(0.55) translate(-6 -7)" opacity={sealed}>
                  <path d="M3 6V4a3 3 0 0 1 6 0v2" stroke="#FFB547" strokeWidth="2" fill="none" />
                  <rect x="1" y="6" width="10" height="7.5" rx="2" fill="#FFB547" />
                </g>
              )}
            </g>
          );
        })}

        {/* one price */}
        <circle r={10 + merge * 14} fill="#13153A" opacity={merge} />
        <circle r={10 + merge * 14 + reveal * 26} fill="none" stroke="#13153A" strokeOpacity={0.35 * (1 - reveal)} strokeWidth="2" />
        <text y="58" textAnchor="middle" fontSize="15" fontWeight="800" fill="#13153A" opacity={reveal} letterSpacing="0.5">ONE PRICE</text>
        <circle r="5" fill="#13153A" opacity={1 - merge} />
      </svg>
      <div className="text-center font-mono text-[11px] tracking-[1.2px] text-night/75">
        {next ? <>NEXT AUCTION {hh(next.hour)} ET{next.secs != null ? <> · <span className="tnum text-night">{mmss(next.secs)}</span></> : " · TONIGHT"}</> : "NEXT AUCTION"}
      </div>
    </div>
  );
}
