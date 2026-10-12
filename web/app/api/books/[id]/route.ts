import { getBook } from "@/lib/chain";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id)) return Response.json({ error: "not a Solana address" }, { status: 400 });
  try {
    const book = await getBook(id);
    return book ? Response.json(book) : Response.json({ error: "no such book" }, { status: 404 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
