import Link from "next/link";
import { Logo } from "@/components/Brand";
import Tape from "@/components/landing/Tape";
import StatusLine from "@/components/landing/StatusLine";
import SaleStory from "@/components/landing/SaleStory";
import AuctionClock from "@/components/landing/AuctionClock";
import BatchTerminal from "@/components/BatchTerminal";
import { loadBooks } from "@/lib/books";
import { GITHUB } from "@/lib/format";

// Devnet state changes under us, so render on every request.
export const dynamic = "force-dynamic";

const MOVES = [
  ["Seal", "The limit is encrypted on your device. Solana stores ciphertext. Only the deposit is public."],
  ["Wait", "Orders collect for the hour. Nobody reads them, front-runs them or fades them. Not even us."],
  ["Clear", "Arcium's network crosses the batch at one price, inside a band around a fresh Pyth price."],
] as const;

export default async function Landing() {
  const { past, totalCleared } = await loadBooks(6);
  const settled = past.reduce((a, b) => a + new Set(b.settlements.map((s) => s.slot)).size, 0);
  const orders = past.reduce((a, b) => a + b.orderCount, 0);

  return (
    <main className="bg-night text-[#F7F7FA]">
      {/* Hero: the claim, and what the chain actually sees */}
      <section className="relative flex min-h-screen flex-col px-5 sm:px-10">
        <div className="mx-auto w-full max-w-[1280px]">
          <StatusLine batches={totalCleared} />
          <nav className="flex items-center justify-between py-5">
            <Link href="/" className="flex items-center gap-3">
              <span className="scale-125"><Logo dark /></span>
              <span className="text-[18px] font-extrabold tracking-[-0.3px]">Lattice Equities</span>
            </Link>
            <div className="flex items-center gap-6 text-[15px] font-semibold">
              {[["The problem", "#problem"], ["Proof", "#proof"], ["GitHub", GITHUB]].map(([l, h]) => (
                <a key={l} href={h} className="hidden text-haze underline-offset-[6px] transition-colors hover:text-white hover:underline md:block">{l}</a>
              ))}
              <Link href="/app" className="rounded-full bg-[#F7F7FA] px-5 py-2.5 font-bold text-night transition-colors hover:bg-amber">Launch app</Link>
            </div>
          </nav>
        </div>

        <div className="mx-auto grid w-full max-w-[1280px] flex-1 items-center gap-12 py-10 lg:grid-cols-12">
          <div className="lg:col-span-8">
            <h1 className="text-[clamp(54px,8.8vw,136px)] font-extrabold leading-[0.88] tracking-[-0.05em]">
              Wall Street<br />closes at 4pm.<br /><span className="text-amber">Tokenized<br />stocks don&apos;t.</span>
            </h1>
            <p className="mt-10 max-w-[520px] text-[19px] leading-[1.5] text-[#C9CBE6]">
              Lattice is a sealed auction where big orders meet at <span className="text-[#F7F7FA]">one fair price, any hour</span>. On Solana, encrypted end to end.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-x-7 gap-y-4">
              <Link href="/app" className="group inline-flex items-center gap-3 rounded-full bg-amber py-4 pr-6 pl-7 text-[17px] font-extrabold text-night transition-transform hover:-translate-y-0.5">
                Seal an order <span className="transition-transform group-hover:translate-x-1">→</span>
              </Link>
              <a href="#problem" className="text-[15px] font-bold text-[#F7F7FA] underline decoration-white/30 underline-offset-[6px] hover:decoration-amber">Replay a real $420K sale</a>
            </div>
          </div>
          <div className="h-[400px] lg:col-span-4 lg:h-[540px]">
            <Tape />
          </div>
        </div>
        <div className="mx-auto flex w-full max-w-[1280px] items-center justify-between border-t border-white/10 pt-5 pb-16 font-mono text-[11px] tracking-[1.2px] text-haze">
          <span>BUILT ON <span className="text-[#F7F7FA]">SOLANA · ARCIUM · PYTH · X402</span></span>
          <a href="#problem" className="flex items-center gap-2 hover:text-white"><span className="max-sm:hidden">SCROLL</span><span className="cue inline-block">↓</span></a>
        </div>
      </section>

      <SaleStory />

      {/* How: three moves, said plainly */}
      <section className="relative z-20 -mt-10 rounded-t-[40px] bg-night px-5 pt-32 pb-36 sm:px-10">
        <div className="mx-auto max-w-[1280px]">
          <h2 className="max-w-[980px] text-[clamp(36px,5vw,72px)] font-extrabold leading-[0.98] tracking-[-0.04em]">
            Stock exchanges open with an auction. <span className="text-haze">We run it every hour, sealed, on Solana.</span>
          </h2>
          <div className="mt-16 grid gap-x-10 gap-y-10 md:grid-cols-3">
            {MOVES.map(([t, d], i) => (
              <div key={t} className="border-t border-white/15 pt-7">
                <div className="flex items-baseline gap-4">
                  <span className="font-mono text-sm text-amber">0{i + 1}</span>
                  <span className="text-[40px] font-extrabold tracking-[-1.5px]">{t}</span>
                </div>
                <p className="mt-3 max-w-[340px] leading-relaxed text-[#C9CBE6]">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Proof: the real devnet log */}
      <section id="proof" className="relative z-30 -mt-10 scroll-mt-0 rounded-t-[40px] bg-page px-5 pt-28 pb-32 text-ink sm:px-10">
        <div className="mx-auto max-w-[1280px]">
          <div>
            <h2 className="text-[clamp(40px,5.6vw,80px)] font-extrabold leading-[0.95] tracking-[-0.045em]">
              It already clears<br />on Solana devnet.
            </h2>
            <p className="mt-6 max-w-[660px] text-[18px] leading-relaxed text-body [text-wrap:pretty]">
              Every batch below was sealed, cleared by Arcium against a fresh Pyth price and settled on-chain. Click any row to check it on Explorer.
            </p>
          </div>

          <div className="mt-14 grid grid-cols-1 border-y border-ink/10 sm:grid-cols-3">
            {[
              [`${totalCleared}`, "batches cleared"],
              [`${settled}/${orders}`, "orders settled, none stuck"],
              ["Same hash", "program rebuilds from GitHub"],
            ].map(([n, c], i) => (
              <div key={c} className={`flex flex-col gap-2 py-7 sm:px-8 ${i ? "border-ink/10 max-sm:border-t sm:border-l" : "sm:pl-0"}`}>
                <span className="tnum text-[clamp(40px,4vw,56px)] font-extrabold leading-none tracking-[-0.045em] text-indigo">{n}</span>
                <span className="font-mono text-[11px] uppercase tracking-[1.2px] text-muted">{c}</span>
              </div>
            ))}
          </div>

          <BatchTerminal past={past} className="mt-10" />
        </div>
      </section>

      {/* Close */}
      <section className="relative z-40 -mt-10 rounded-t-[40px] bg-amber px-5 pt-24 pb-20 text-night sm:px-10 sm:pt-28">
        <div className="mx-auto grid max-w-[1280px] grid-cols-1 items-end gap-10 lg:grid-cols-[1fr_auto]">
          <h2 className="text-[clamp(52px,8.4vw,128px)] font-extrabold leading-[1.02] tracking-[-0.05em]">
            One order.<br />One price.<br />Any hour.
          </h2>
          <div className="justify-self-start lg:justify-self-end lg:mr-6"><AuctionClock /></div>
        </div>
        <div className="mx-auto mt-16 flex max-w-[1280px] flex-wrap justify-between gap-3 border-t border-night/15 pt-5 font-mono text-[11px] tracking-[1.2px] text-night/70">
          <span>LATTICE EQUITIES · SEALED BATCH AUCTIONS FOR TOKENIZED STOCKS</span>
          <a href={GITHUB} className="hover:text-night">GITHUB.COM/AYOSHISS/LATTICE-EQUITIES ↗</a>
        </div>
      </section>
    </main>
  );
}
