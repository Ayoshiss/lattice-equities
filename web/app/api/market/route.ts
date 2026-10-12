import { getMarket } from "@/lib/market";

export async function GET() {
  try {
    return Response.json(await getMarket());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
