import type { Metadata } from "next";
import AppHeader from "@/components/auction/AppHeader";
import NextAuction from "@/components/auction/NextAuction";
import Tonight from "@/components/auction/Tonight";
import LastAuction from "@/components/auction/LastAuction";
import OrderPanel from "@/components/auction/OrderPanel";
import LastBatch from "@/components/auction/LastBatch";
import BatchTerminal from "@/components/BatchTerminal";
import { loadBooks } from "@/lib/books";
import { GITHUB } from "@/lib/format";

export const metadata: Metadata = { title: "Lattice Equities: tonight's TSLAx auctions" };
export const dynamic = "force-dynamic";

export default async function App() {
  const { latest, past, totalCleared } = await loadBooks(8);
  const bandBps = latest?.bandBps ?? 200;
  const now = Date.now() / 1000;
  const lastCleared = past[0] ?? null;

  return (
    <div className="flex min-h-screen flex-col bg-page text-ink">
      <AppHeader batches={totalCleared} />
      <main className="mx-auto box-border flex w-full max-w-[1440px] sm:max-w-[1440px] lg:max-w-[calc(1360px+5rem)] grow flex-wrap gap-6 px-5 pt-8 pb-10 sm:px-10">
        <div className="flex min-w-0 flex-[999_1_640px] flex-col gap-6">
          <NextAuction />
          <Tonight />
          <LastAuction book={lastCleared} now={now} />
        </div>
        <OrderPanel bandBps={bandBps} />

        <div className="mt-4 w-full"><LastBatch initial={latest} now={now} /></div>

        <section id="history" className="mt-10 w-full scroll-mt-28">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
            <h2 className="text-[clamp(28px,3vw,40px)] font-extrabold tracking-[-0.04em]">History on devnet</h2>
            <a href={GITHUB} className="font-mono text-[12px] text-indigo hover:underline">program rebuilds from GitHub, same hash ↗</a>
          </div>
          <BatchTerminal past={past} />
        </section>

        <footer className="mt-10 flex w-full flex-wrap justify-between gap-3 border-t border-line pt-5 font-mono text-[11px] tracking-[1.2px] text-muted">
          <span>LATTICE EQUITIES · SEALED BATCH AUCTIONS ON SOLANA</span>
          <span>UNAUDITED · DEVNET TEST TOKENS · ITEMS TAGGED DEMO DATA ARE NOT ON-CHAIN YET</span>
        </footer>
      </main>
    </div>
  );
}
