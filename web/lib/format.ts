// Small display helpers shared by server and client components.

export const GITHUB = "https://github.com/Ayoshiss/lattice-equities";
export const PROGRAM_ID = "AUXkwEowRX7BMPXGF1Ak2nC9Ni5SML7EU6fB6Jo1zvgm";

export const explorer = (kind: "tx" | "address", id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

export const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

export const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const amount = (n: number, digits = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

// "fa799526 b8cb8c14 9bdf28b1": the first few 4-byte groups of a ciphertext.
export const groups = (hex: string, n = 3) =>
  Array.from({ length: n }, (_, i) => hex.slice(i * 8, i * 8 + 8)).join(" ");

export const toHex = (bytes: ArrayLike<number>) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function ago(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return `${d} day${d === 1 ? "" : "s"}`;
}

// The band is stored as [ref × (1 − bps), ref × (1 + bps)], so its midpoint is
// the Pyth price the batch was checked against.
export function pythDistance(clear: number, lo: number, hi: number) {
  const ref = (lo + hi) / 2;
  const pct = ((clear - ref) / ref) * 100;
  return { ref, pct, label: `${Math.abs(pct).toFixed(2)}% ${pct < 0 ? "below" : "above"}` };
}
