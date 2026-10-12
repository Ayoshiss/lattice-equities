"use client";
// Two tiers: a night status line (live Pyth price, New York time, session, devnet),
// then the app bar (brand, sections, wallet).
import Link from "next/link";
import { Logo } from "../Brand";
import { useMarket } from "../Sealed";
import { usd } from "@/lib/format";
import { nyParts, sessionLabel, useClock } from "./clock";

export default function AppHeader({ batches }: { batches: number }) {
  const { market, now } = useMarket();
  const clock = useClock();
  const t = market?.tsla;
  const age = t ? Math.max(0, Math.round(now - t.publishTime)) : null;
  const ny = clock ? nyParts(clock.ms) : null;
  const sess = clock ? sessionLabel(clock.ms, clock.demo ? undefined : market?.session?.isOpen) : null;
  const pad = (n: number) => String(n).padStart(2, "0");

  return (
    <header className="sticky top-0 z-30">
      <div className="bg-night px-5 sm:px-10">
        <div className="mx-auto flex max-w-[1360px] flex-wrap gap-x-8 gap-y-1 py-2.5 font-mono text-[11.5px] tracking-[0.5px]">
          <span className="flex gap-2"><span className="text-haze">TSLA</span><span className="tnum text-[#F7F7FA]">{t ? usd(t.price) : "···"}</span>{age !== null && <span className="text-amber">pyth {age}s</span>}</span>
          <span className="flex gap-2"><span className="text-haze">NEW YORK</span><span className="tnum text-[#F7F7FA]">{ny ? `${pad(ny.h)}:${pad(ny.m)}:${pad(ny.s)}` : "··:··:··"}</span>{clock?.demo && <span className="text-amber">demo clock</span>}</span>
          <span className="flex items-center gap-2 max-sm:hidden"><span className="text-haze">SESSION</span><span className={`size-1.5 rounded-full ${sess?.night ? "bg-amber" : "bg-[#7EE2A8]"}`} /><span className="text-[#F7F7FA]">{sess?.label ?? "···"}</span></span>
          <span className="flex gap-2 max-md:hidden"><span className="text-haze">DEVNET</span><span className="text-[#F7F7FA]">{batches} batches cleared</span></span>
        </div>
      </div>
      <div className="border-b border-line bg-white/90 px-5 backdrop-blur sm:px-10">
        <div className="mx-auto flex max-w-[1360px] items-center gap-4 py-3.5 sm:gap-8">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo />
            <span className="whitespace-nowrap text-[17px] font-extrabold tracking-[-0.3px]">Lattice Equities</span>
          </Link>
          <nav aria-label="Main" className="flex gap-6 text-[15px] font-semibold max-sm:hidden">
            {[["Auction", "#auctions", true], ["Last batch", "#batch", false], ["History", "#history", false]].map(([l, h, on]) => (
              <a key={l as string} href={h as string} className={`relative py-1 ${on ? "text-ink after:absolute after:inset-x-0 after:-bottom-[15px] after:h-[2px] after:bg-indigo" : "text-muted hover:text-ink"}`}>{l}</a>
            ))}
          </nav>
          <div className="grow" />
          <button type="button" disabled title="Wallet orders are the next build" className="cursor-not-allowed whitespace-nowrap rounded-full bg-night px-4 py-2.5 text-sm font-bold text-[#F7F7FA]/85 sm:px-5">
            Connect wallet
          </button>
        </div>
      </div>
    </header>
  );
}
