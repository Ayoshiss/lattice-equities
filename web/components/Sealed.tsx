"use client";
// The hero ticket and the "Why sealed" comparison. Both show the same order, so
// they share state. Encryption is real: the order is sealed in this browser to
// the Arcium MXE key on devnet, exactly as the demo script does it.
import { useEffect, useRef, useState } from "react";
import type { Market } from "@/lib/market";
import { amount, groups, toHex, usd } from "@/lib/format";
import PriceChart, { type Clear } from "./PriceChart";

export const BUY = 1, SELL = 0; // program encoding
const QUOTE_ATOMS = 1e6; // USDC decimals; one lot is one share
export const STALE_AFTER_SECS = 120;

// "5h 10m", "2d 3h", "12m"
export function until(secs: number) {
  const m = Math.max(0, Math.round(secs / 60));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

export type Cipher = { side: string; price: string; qty: string };

export function useMarket() {
  const [market, setMarket] = useState<Market | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/market")
        .then((r) => (r.ok ? r.json() : null))
        .then((m) => live && m && setMarket(m))
        .catch(() => {});
    load();
    const poll = setInterval(load, 10_000);
    const tick = setInterval(() => setNow(Date.now() / 1000), 1_000);
    return () => { live = false; clearInterval(poll); clearInterval(tick); };
  }, []);
  return { market, now };
}

// Seals (side, price, qty) with a fresh nonce whenever the order changes.
export function useSealed(mxeKey: string | undefined, side: number, price: number, qty: number) {
  const [cipher, setCipher] = useState<Cipher | null>(null);
  const secret = useRef<Uint8Array | null>(null);
  useEffect(() => {
    if (!mxeKey || !(price > 0) || !(qty > 0)) return;
    let live = true;
    import("@arcium-hq/client").then(({ x25519, RescueCipher }) => {
      if (!live) return;
      secret.current ??= x25519.utils.randomSecretKey();
      const mxe = Uint8Array.from(mxeKey.match(/../g)!.map((h) => parseInt(h, 16)));
      const rc = new RescueCipher(x25519.getSharedSecret(secret.current, mxe));
      const nonce = crypto.getRandomValues(new Uint8Array(16));
      const [s, p, q] = rc.encrypt([BigInt(side), BigInt(Math.round(price * QUOTE_ATOMS)), BigInt(qty)], nonce);
      setCipher({ side: toHex(s), price: toHex(p), qty: toHex(q) });
    });
    return () => { live = false; };
  }, [mxeKey, side, price, qty]);
  return cipher;
}

const placeholder = "········ ········ ········";

const HEX = "0123456789abcdef";

// Cycles random hex for a moment, then resolves left to right into the real
// ciphertext, so the visitor sees each re-seal land.
function useScramble(target: string | undefined, ms = 450) {
  const [out, setOut] = useState(target);
  useEffect(() => {
    if (!target || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setOut(target);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      const fixed = Math.floor(p * target.length);
      setOut(
        target.slice(0, fixed) +
          Array.from(target.slice(fixed), (c) => (c === " " ? " " : HEX[(Math.random() * 16) | 0])).join(""),
      );
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return out;
}

export function CipherRow({ label, hex }: { label: string; hex?: string }) {
  const shown = useScramble(hex ? groups(hex) : undefined);
  return (
    <div className="flex items-center justify-between gap-4 font-mono text-sm">
      <span className="shrink-0 text-[#8F92B0]">{label}</span>
      <span className="truncate text-lime">{shown ?? placeholder}</span>
    </div>
  );
}

function Lock({ open }: { open: boolean }) {
  return (
    <svg width="12" height="14" viewBox="0 0 12 14" fill="none" aria-hidden className="shrink-0 overflow-visible">
      <path
        d="M3 6V4a3 3 0 0 1 6 0v2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        className="transition-transform duration-200"
        style={{ transform: open ? "translateY(-2.5px)" : "none" }}
      />
      <rect x="1" y="6" width="10" height="7.5" rx="2" fill="currentColor" />
    </svg>
  );
}

// "sealing" with an open lock while a new ciphertext lands, then a closed lock,
// a small pop and one shine sweep.
export function SealBadge({ stamp, tone }: { stamp?: string; tone: "dark" | "light" }) {
  const [sealing, setSealing] = useState(false);
  useEffect(() => {
    if (!stamp) return;
    setSealing(true);
    const t = setTimeout(() => setSealing(false), 450);
    return () => clearTimeout(t);
  }, [stamp]);
  const waiting = tone === "dark" ? "bg-white/10 text-lime ring-1 ring-lime/40" : "bg-tint text-indigo";
  return (
    <span
      key={sealing ? "sealing" : `sealed-${stamp}`}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold ${
        sealing || !stamp ? waiting : "seal-pop seal-shine bg-amber text-night"
      }`}
    >
      <Lock open={sealing || !stamp} />
      {sealing ? "sealing" : stamp ? "sealed" : "waiting"}
    </span>
  );
}

export function Field({ label, value, onChange, prefix }: { label: string; value: string; onChange: (v: string) => void; prefix?: string }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-sm font-semibold text-muted">{label}</span>
      <span className="flex items-center rounded-xl border border-line px-3.5 py-2.5 text-xl font-semibold focus-within:border-indigo">
        {prefix && <span className="text-muted">{prefix}</span>}
        <input
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
          className="w-full min-w-0 bg-transparent outline-none"
        />
      </span>
    </label>
  );
}

export default function Sealed({ bandBps, clears }: { bandBps: number; clears: Clear[] }) {
  const { market, now } = useMarket();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [limit, setLimit] = useState("");
  const [shares, setShares] = useState("10");
  const touched = useRef(false);

  // Start the limit at the live price until the visitor types their own.
  useEffect(() => {
    if (!touched.current && market?.tsla) setLimit(market.tsla.price.toFixed(2));
  }, [market?.tsla?.price]);

  const price = parseFloat(limit);
  const qty = Math.floor(parseFloat(shares));
  const valid = price > 0 && qty > 0;
  const cipher = useSealed(market?.mxeKey, side === "buy" ? BUY : SELL, price, qty);
  const deposit = side === "buy" ? `${amount(price * qty)} USDC` : `${qty} TSLA`;

  const tsla = market?.tsla;
  const age = tsla ? now - tsla.publishTime : null;
  const fresh = age !== null && age < STALE_AFTER_SECS;
  const session = market?.session;
  const status = !tsla
    ? { ok: false, text: "Loading Pyth price" }
    : !fresh
      ? { ok: false, text: "Pyth price is stale, auctions wait" }
      : session?.isOpen
        ? { ok: true, text: session.nextClose ? `Market open, closes in ${until(session.nextClose - now)}` : "US market open" }
        : session
          ? { ok: false, text: session.nextOpen ? `Market closed, opens in ${until(session.nextOpen - now)}` : "US market closed" }
          : { ok: true, text: `Pyth price, ${Math.max(0, Math.round(age!))}s old` };

  return (
    <>
      <section className="mt-8 grid grid-cols-1 gap-8 rounded-[32px] bg-indigo p-4 py-8 sm:p-10 lg:grid-cols-12 lg:gap-6 lg:p-12">
        <div className="flex flex-col justify-center gap-6 px-2 text-white sm:px-0 lg:col-span-7">
          <span className="self-start rounded-full bg-lime px-3 py-1 text-sm font-bold text-ink">Live on Solana devnet</span>
          <h1 className="text-[40px] font-medium leading-[1.05] tracking-[-1.5px] [text-wrap:balance] sm:text-[56px] sm:tracking-[-2px]">
            Trade tokenized stocks without showing your hand.
          </h1>
          <p className="max-w-[560px] text-lg text-[#E6E3FF] [text-wrap:balance] sm:text-xl">
            Your order is encrypted on your device. The whole batch clears at one fair price, and nobody, including us, sees your limit.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <a href="#auction" className="rounded-xl bg-white px-5 py-3.5 font-bold text-indigo">See the latest auction</a>
            <a href="#why" className="px-2 py-3.5 font-bold text-white">How it works →</a>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-sm font-semibold text-white/80">Built on</span>
            {["Solana", "Arcium MPC", "Pyth", "x402"].map((t) => (
              <span key={t} className="rounded-full bg-white/15 px-3 py-1 text-sm font-bold text-white">{t}</span>
            ))}
            <a href="https://github.com/Ayoshiss/lattice-equities" className="rounded-full bg-lime px-3 py-1 text-sm font-bold text-ink">Reproducible build</a>
          </div>
        </div>

        <div className="min-w-0 lg:col-span-5">
          <div className="card flex flex-col gap-4 p-4 sm:p-6">
            <PriceChart live={tsla?.price ?? null} clears={clears} />
            <div className="-mt-1 flex items-center justify-between gap-4 border-b border-line pb-4 text-sm">
              <span className="flex min-w-0 items-center text-body">
                <span className={`mr-2 inline-block size-2 shrink-0 rounded-full ${status.ok ? "bg-[#22C55E]" : "bg-[#F5A524]"}`} />
                <span className="truncate">{status.text}</span>
              </span>
              <span className="hidden shrink-0 text-muted sm:inline">band ±{bandBps / 100}%</span>
            </div>

            <div className="flex rounded-xl bg-page p-1">
              {(["buy", "sell"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSide(s)}
                  className={`flex-1 rounded-[9px] py-2.5 font-bold capitalize ${side === s ? "bg-white text-ink shadow-sm" : "text-muted"}`}
                >
                  {s}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Limit price" prefix="$" value={limit} onChange={(v) => { touched.current = true; setLimit(v); }} />
              <Field label="Shares" value={shares} onChange={setShares} />
            </div>

            <div className="flex flex-col gap-2 rounded-2xl bg-ink p-5 text-white">
              <div className="flex items-center justify-between">
                <span className="font-bold">What Solana sees</span>
                <SealBadge tone="dark" stamp={valid ? cipher?.price : undefined} />
              </div>
              <CipherRow label="limit" hex={valid ? cipher?.price : undefined} />
              <CipherRow label="size" hex={valid ? cipher?.qty : undefined} />
            </div>

            <div className="flex flex-col gap-1.5 text-sm">
              <div className="flex justify-between gap-4"><span className="text-body">Deposit, public</span><span className="font-bold">{valid ? deposit : "—"}</span></div>
              <div className="flex justify-between gap-4"><span className="text-body">Relay fee, over x402</span><span className="font-bold">$0.001</span></div>
            </div>

            <button disabled className="cursor-not-allowed rounded-xl border-[1.5px] border-indigo/40 px-5 py-3.5 font-bold text-indigo/60">
              Wallet orders coming next
            </button>
            <span className="-mt-2 text-center text-sm text-muted">Unaudited · devnet only</span>
          </div>
        </div>
      </section>

      <section id="why" className="mt-24 scroll-mt-8">
        <div className="text-sm font-semibold text-indigo">Why sealed</div>
        <h2 className="mt-2 text-[32px] font-semibold leading-tight tracking-[-1px]">The same order, two venues.</h2>
        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="card flex min-w-0 flex-col gap-4 p-6 sm:p-8">
            <div className="flex items-center justify-between">
              <span className="text-xl font-bold">On a public pool</span>
              <span className="rounded-full bg-page px-3 py-1 text-sm font-bold text-body">readable</span>
            </div>
            <div className="flex flex-col gap-2.5 rounded-2xl bg-page p-5">
              {[
                ["Side", side.toUpperCase()],
                ["Limit price", valid ? usd(price) : "—"],
                ["Size", valid ? `${qty} shares` : "—"],
                ["Deposit", valid ? deposit : "—"],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4"><span className="text-body">{k}</span><span className="font-bold">{v}</span></div>
              ))}
            </div>
            <p className="text-body">Every bot sees it before it fills and can trade ahead of you.</p>
          </div>
          <div className="card flex min-w-0 flex-col gap-4 border-2 border-indigo p-6 sm:p-8">
            <div className="flex items-center justify-between">
              <span className="text-xl font-bold">On Lattice</span>
              <SealBadge tone="light" stamp={valid ? cipher?.price : undefined} />
            </div>
            <div className="flex flex-col gap-2.5 rounded-2xl bg-ink p-5 text-white">
              <CipherRow label="side" hex={valid ? cipher?.side : undefined} />
              <CipherRow label="limit" hex={valid ? cipher?.price : undefined} />
              <CipherRow label="size" hex={valid ? cipher?.qty : undefined} />
              <div className="flex items-center justify-between gap-4 font-mono text-sm">
                <span className="text-[#8F92B0]">deposit</span>
                <span className="truncate">{valid ? `${deposit} · public` : "—"}</span>
              </div>
            </div>
            <p className="text-body">
              Price and size stay sealed. Only the deposit is public, and you can deposit more than you need to blur it. The rest comes back at settlement.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
