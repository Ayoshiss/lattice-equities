"use client";
// Scroll-driven replay of the 6 Oct sale. First the 13 real slices land under the
// Pyth price and the loss counts up to the measured $1,931. Then the same order,
// as one sealed Lattice order, clears once at one price (an illustration).
import { useEffect, useRef, useState } from "react";
import { PYTH_PATH, SALES } from "./sale";

const TOTAL = 1931;
const gaps = SALES.map((s) => s.fairPx - s.px);
const per = gaps.map((g) => (g / gaps.reduce((a, b) => a + b, 0)) * TOTAL);
const TARGET = { x: 930, y: 172 }; // on the Pyth line, about $378.40
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const MONO = "var(--font-jetbrains)";

export default function SaleStory() {
  const ref = useRef<HTMLElement>(null);
  const [p, setP] = useState(0);
  useEffect(() => {
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = ref.current!.getBoundingClientRect();
        setP(clamp(-r.top / (r.height - innerHeight)));
      });
    };
    on(); addEventListener("scroll", on, { passive: true }); addEventListener("resize", on);
    return () => { removeEventListener("scroll", on); removeEventListener("resize", on); cancelAnimationFrame(raf); };
  }, []);

  const a = clamp((p - 0.04) / 0.5);          // slices landing
  const shown = Math.round(a * SALES.length);
  const b = ease(clamp((p - 0.62) / 0.26));   // collapse into one order
  const lost = per.slice(0, shown).reduce((x, y) => x + y, 0);
  const late = b > 0.5;

  return (
    <section ref={ref} id="problem" className="relative z-10 -mt-10 h-[340vh] scroll-mt-0 rounded-t-[40px] bg-page text-ink">
      <div className="sticky top-0 flex h-screen flex-col overflow-hidden px-5 sm:px-10">
        <div className="mx-auto flex w-full max-w-[1280px] items-center justify-between pt-8 font-mono text-[11px] tracking-[1.2px] text-muted sm:pt-10">
          <span>A REAL SALE · TUE 6 OCT 2026 · RAYDIUM TSLAx/USDC</span>
          <span className="max-sm:hidden">ON-CHAIN DATA, PRICED AGAINST PYTH</span>
        </div>

        <div className="mx-auto grid w-full max-w-[1280px] flex-1 items-center gap-6 lg:grid-cols-12 lg:gap-12">
          <div className="lg:col-span-4">
            <div className="grid">
              <div className="[grid-area:1/1] transition-opacity duration-500" style={{ opacity: late ? 0 : 1 }} aria-hidden={late}>
                <h2 className="text-[clamp(36px,4.2vw,58px)] font-extrabold leading-[0.95] tracking-[-0.045em]">One seller.<br />$420K of Tesla.<br /><span className="text-[#E5484D]">A thin pool.</span></h2>
                <p className="mt-5 max-w-[360px] text-[17px] leading-relaxed text-body">To avoid crashing the price, the order goes in as slices. Every one lands under the fair price.</p>
              </div>
              <div className="[grid-area:1/1] transition-opacity duration-500" style={{ opacity: late ? 1 : 0 }} aria-hidden={!late}>
                <h2 className="text-[clamp(36px,4.2vw,58px)] font-extrabold leading-[0.95] tracking-[-0.045em]">Same order.<br /><span className="text-indigo">Sealed.</span><br />Cleared once.</h2>
                <p className="mt-5 max-w-[360px] text-[17px] leading-relaxed text-body">On Lattice it is one order with a limit at the fair price, cleared in one auction at one price inside the Pyth band.</p>
              </div>
            </div>

            <div className="mt-8 border-t border-ink/10 pt-5">
              <div className="font-mono text-[11px] tracking-[1.2px] text-muted">{late ? "LATTICE FEE, ONE ORDER" : `LOST TO SLICING · ${shown} OF 13`}</div>
              <div className="mt-2 flex items-baseline gap-4">
                <span className={`tnum text-[clamp(52px,5.4vw,76px)] font-extrabold leading-none tracking-[-0.05em] transition-colors duration-500 ${late ? "text-indigo" : "text-[#E5484D]"}`}>
                  ${late ? "210" : Math.round(lost).toLocaleString()}
                </span>
                <span className={`font-mono text-sm text-muted line-through transition-opacity duration-500 ${late ? "opacity-100" : "opacity-0"}`}>$1,931</span>
              </div>
            </div>
          </div>

          <div className="lg:col-span-8">
            <div className="rounded-[28px] bg-white p-4 shadow-[0_1px_0_rgba(19,21,58,0.04),0_24px_60px_-30px_rgba(19,21,58,0.25)] sm:p-7">
              <svg viewBox="0 0 1100 640" className="h-auto w-full" role="img" aria-label="Thirteen sales landing under the Pyth price, then one sealed order clearing at the fair price">
                {[[376, 580], [377, 396.7], [378, 213.3], [379, 30]].map(([v, y]) => (
                  <g key={v}><line x1="70" x2="1070" y1={y} y2={y} stroke="#EEEEF4" /><text x="56" y={y + 6} textAnchor="end" fontSize="18" fill="#8A8DA3" fontFamily={MONO}>${v}</text></g>
                ))}
                <text x="433.8" y="624" textAnchor="middle" fontSize="18" fill="#8A8DA3" fontFamily={MONO}>11pm</text>
                <text x="828.6" y="624" textAnchor="middle" fontSize="18" fill="#8A8DA3" fontFamily={MONO}>midnight</text>
                <path d={PYTH_PATH} fill="none" stroke="#13153A" strokeWidth="2.5" strokeDasharray="1 6" strokeLinecap="round" />
                <g transform="translate(700 68)">
                  <rect x="-170" y="-22" width="170" height="34" rx="17" fill="#13153A" />
                  <text x="-85" y="0" textAnchor="middle" fontSize="17" fontWeight="700" fill="#F7F7FA">Pyth fair price</text>
                </g>
                {SALES.map((s, i) => {
                  const on = i < shown;
                  const x = s.x + (TARGET.x - s.x) * b, y = s.y + (TARGET.y - s.y) * b;
                  return (
                    <g key={i} style={{ opacity: on ? 1 : 0, transition: "opacity .3s" }}>
                      <line x1={s.x} x2={s.x} y1={s.fair} y2={s.y} stroke="#E5484D" strokeOpacity={0.28 * (1 - b)} strokeWidth="8" strokeLinecap="round" />
                      <circle cx={x} cy={y} r={10 + b * 3} fill={late ? "#5546FF" : "#E5484D"} stroke="#fff" strokeWidth="3" style={{ transition: "fill .4s" }} />
                    </g>
                  );
                })}
                <g style={{ opacity: b > 0.96 ? 1 : 0, transition: "opacity .4s" }}>
                  <circle cx={TARGET.x} cy={TARGET.y} r="40" fill="#5546FF" fillOpacity="0.12" />
                  <circle cx={TARGET.x} cy={TARGET.y} r="17" fill="#5546FF" stroke="#fff" strokeWidth="4" />
                  <g transform={`translate(${TARGET.x} ${TARGET.y + 80})`}>
                    <rect x="-118" y="-24" width="236" height="38" rx="19" fill="#5546FF" />
                    <text x="0" y="1" textAnchor="middle" fontSize="18" fontWeight="800" fill="#fff">$378.40 · one price</text>
                  </g>
                </g>
              </svg>
            </div>

            <div className="mt-5 flex items-center gap-4 font-mono text-[11px] tracking-[1px]">
              <span className={late ? "text-muted" : "text-[#E5484D]"}>RAYDIUM · 13 SLICES</span>
              <div className="relative h-[3px] flex-1 overflow-hidden rounded-full bg-ink/10">
                <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#E5484D] to-indigo" style={{ width: `${Math.round(p * 100)}%` }} />
              </div>
              <span className={late ? "text-indigo" : "text-muted"}>LATTICE · ONE AUCTION</span>
            </div>
            <div className="mt-2 text-right font-mono text-[10px] tracking-[0.8px] text-muted/80">
              {late ? "Lattice clear shown as an illustration" : "Per-slice loss scaled to the measured $1,931 total"}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
