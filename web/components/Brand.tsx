import Link from "next/link";

export function Logo({ dark = false }: { dark?: boolean }) {
  return (
    <span className="grid grid-cols-[10px_10px] gap-[3px]" aria-hidden>
      <i className={`size-2.5 rounded-[3px] ${dark ? "bg-white" : "bg-indigo"}`} />
      <i className={`size-2.5 rounded-[3px] ${dark ? "bg-white" : "bg-indigo"}`} />
      <i className={`size-2.5 rounded-[3px] ${dark ? "bg-white" : "bg-indigo"}`} />
      <i className="size-2.5 rounded-[3px] bg-lime" />
    </span>
  );
}

export function Wordmark({ dark = false }: { dark?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <Logo dark={dark} />
      <span className={`text-lg font-bold tracking-tight ${dark ? "text-white" : "text-ink"}`}>Lattice Equities</span>
    </Link>
  );
}
