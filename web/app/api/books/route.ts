import { listBooks } from "@/lib/chain";

export async function GET() {
  try {
    return Response.json(await listBooks());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
