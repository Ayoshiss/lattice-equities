import { NextResponse, type NextRequest } from "next/server";
import { RANGES, getHistory, type Range } from "@/lib/market";

export async function GET(req: NextRequest) {
  const range = req.nextUrl.searchParams.get("range") ?? "1D";
  if (!(range in RANGES)) return NextResponse.json({ error: "range must be 1D, 1W or 1M" }, { status: 400 });
  try {
    return NextResponse.json(await getHistory(range as Range));
  } catch {
    return NextResponse.json({ error: "price history unavailable" }, { status: 502 });
  }
}
