import { getBook, listBooks, type BookDetail } from "./chain";

// The latest batch with orders plus the most recent cleared ones, read from devnet.
export async function loadBooks(limit = 8) {
  try {
    const books = await listBooks();
    const latest = books.find((b) => b.orderCount > 0);
    const cleared = books.filter((b) => b.status === "cleared").slice(0, limit);
    const ids = [...new Set([latest?.address, ...cleared.map((b) => b.address)].filter(Boolean) as string[])];
    const details = await Promise.all(ids.map((id) => getBook(id)));
    const byId = new Map(details.filter((d): d is BookDetail => !!d).map((d) => [d.address, d]));
    return {
      latest: latest ? byId.get(latest.address) ?? null : null,
      past: cleared.map((b) => byId.get(b.address)).filter((d): d is BookDetail => !!d),
      totalCleared: books.filter((b) => b.status === "cleared").length,
    };
  } catch {
    return { latest: null, past: [] as BookDetail[], totalCleared: 0 };
  }
}
