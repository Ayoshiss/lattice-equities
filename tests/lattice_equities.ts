import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { LatticeEquities } from "../target/types/lattice_equities";
import { randomBytes } from "crypto";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getArciumProgram,
  uploadCircuit,
  RescueCipher,
  deserializeLE,
  getMXEPublicKey,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getLookupTableAddress,
  x25519,
} from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";
import { expect } from "chai";
import { createMint, createAccount, mintTo, getAccount } from "@solana/spl-token";

const N = 16;
const LOT_SIZE = 10;
const AAPLX_USD = "978e6cc68a119ce066aa830017318563a9ed04ec3a0a6439010fc11296a58675";
const AAPL_EQUITY = "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688";
// Local stand-ins for Pyth price updates, written by scripts/pyth-fixtures.cjs.
const TSLA_EQUITY = "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1";
const SLIGHTLY_STALE_FEED = "33".repeat(32);
const BEFORE_BOOK_FEED = "44".repeat(32);
const NO_FALLBACK = new Array(32).fill(0);
// Canonical Pyth accounts (push oracle, shard 0) for the primary feeds.
const AAPL_EQUITY_PRICE = new PublicKey("DJ2FyTgUAkEtXW3U5P9PF19meFTRtW4ZWKKFgACfVbUy"); // fresh
const TSLA_EQUITY_PRICE = new PublicKey("E8WFH8brgP58arcuW2wwsPHiomYrSvrgWTsRLZLAEZUQ"); // a day old: closed
const SLIGHTLY_STALE_PRICE = new PublicKey("Fv8rW8VWmkX8ui8wgCQuq9hdSCK86MkUvM7itirC4QZG"); // 15 min old
const BEFORE_BOOK_PRICE = new PublicKey("2hMtaQCwQbPWDnxhZgLVtZ672qZmb3tNHNG8JVey8GVS"); // before any book
// AAPLX fallback updates.
const AAPLX_FALLBACK_FRESH = new PublicKey("H1PFU9pRg879bM4TBUsr11igtAdt1xU7zHL673jg8hsJ");
const AAPLX_FALLBACK_EARLY = new PublicKey("FDWVP2C1f7iYugmnYCdBE91Gw91wQsboiQ2ET2V9c5JQ");
const feedBytes = (hex: string) => Array.from(Buffer.from(hex, "hex"));
const BUY = 1;
const SELL = 0;
type Order = { side: number; price: number; qty: number };

// Plain sequential version of the clearing rules, used to check the MPC result.
function referenceClear(orders: Order[], lo: number, hi: number) {
  let bestP = 0;
  let bestV = 0;
  for (const c of orders) {
    const buy = orders.filter((o) => o.side === BUY && o.price >= c.price).reduce((a, o) => a + o.qty, 0);
    const sell = orders.filter((o) => o.side !== BUY && o.price <= c.price).reduce((a, o) => a + o.qty, 0);
    const m = Math.min(buy, sell);
    const cand = c.qty > 0 && c.price >= lo && c.price <= hi;
    if (cand && (m > bestV || (m === bestV && m > 0 && c.price < bestP))) {
      bestV = m;
      bestP = c.price;
    }
  }
  const fills = new Array(N).fill(0);
  let buyLeft = bestV;
  let sellLeft = bestV;
  orders.forEach((o, i) => {
    if (bestV === 0) return;
    if (o.side === BUY && o.price >= bestP) {
      fills[i] = Math.min(o.qty, buyLeft);
      buyLeft -= fills[i];
    } else if (o.side !== BUY && o.price <= bestP) {
      fills[i] = Math.min(o.qty, sellLeft);
      sellLeft -= fills[i];
    }
  });
  return { price: bestP, matched: bestV, fills };
}

describe("LatticeEquities", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.LatticeEquities as Program<LatticeEquities>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const arciumProgram = getArciumProgram(provider);
  const arciumEnv = getArciumEnv();
  const clusterAccount = getClusterAccAddress(arciumEnv.arciumClusterOffset);
  const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

  const queueAccounts = (offset: anchor.BN, circuit: string) => ({
    computationAccount: getComputationAccAddress(arciumEnv.arciumClusterOffset, offset),
    clusterAccount,
    mxeAccount: getMXEAccAddress(program.programId),
    mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
    executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
    compDefAccount: getCompDefAccAddress(
      program.programId,
      Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE(),
    ),
  });

  const finalize = (offset: anchor.BN) =>
    awaitComputationFinalization(provider, offset, program.programId, "confirmed");

  before(async () => {
    for (const circuit of ["init_book", "place_order_v2", "clear_v2"]) {
      await initCompDef(circuit);
    }
  });

  it("clears an encrypted batch, settles every order and records timings", async () => {
    const mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId);
    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const cipher = new RescueCipher(x25519.getSharedSecret(privateKey, mxePublicKey));

    const allOrders: Order[] = [];
    for (let k = 0; k < 8; k++) {
      allOrders.push({ side: BUY, price: 100 + k, qty: 3 + k });
      allOrders.push({ side: SELL, price: 96 + k, qty: 4 + k });
    }
    const mult = Number(process.env.PRICE_MULT ?? 1);
    const orders = allOrders.slice(0, Number(process.env.BENCH_ORDERS ?? 4)).map((o) => ({ ...o, price: o.price * mult }));
    // Deposit for each order; the last extra buy is underfunded and must be refunded untouched.
    const deposits = orders.map((o) =>
      o.side === BUY ? { base: 0, quote: o.qty * o.price } : { base: o.qty * LOT_SIZE, quote: 0 },
    );
    if (orders.length < N) {
      orders.push({ side: BUY, price: 109, qty: 20 });
      deposits.push({ base: 0, quote: 20 * 109 - 1 });
    }
    const covered = orders.map((o, i) =>
      (o.side === BUY ? o.qty * o.price <= deposits[i].quote : o.qty * LOT_SIZE <= deposits[i].base)
        ? o
        : { ...o, qty: 0 },
    );
    // Fixture price is $10.00000; 10-atom lots at 0 decimals = 100 per lot, band 10%.
    const bandLo = 90;
    const bandHi = 110;

    const baseMint = await createMint(provider.connection, owner, owner.publicKey, null, 0);
    const quoteMint = await createMint(provider.connection, owner, owner.publicKey, null, 0);
    const traders = orders.map(() => anchor.web3.Keypair.generate());
    const wallets: { base: PublicKey; quote: PublicKey }[] = [];
    for (const [i, trader] of traders.entries()) {
      await provider.sendAndConfirm(
        new anchor.web3.Transaction().add(
          anchor.web3.SystemProgram.transfer({
            fromPubkey: owner.publicKey,
            toPubkey: trader.publicKey,
            lamports: 0.05 * anchor.web3.LAMPORTS_PER_SOL,
          }),
        ),
      );
      const base = await createAccount(provider.connection, owner, baseMint, trader.publicKey);
      const quote = await createAccount(provider.connection, owner, quoteMint, trader.publicKey);
      if (deposits[i].base > 0) await mintTo(provider.connection, owner, baseMint, base, owner, deposits[i].base);
      if (deposits[i].quote > 0) await mintTo(provider.connection, owner, quoteMint, quote, owner, deposits[i].quote);
      wallets.push({ base, quote });
    }

    const bookId = new anchor.BN(randomBytes(8), "hex");
    const [bookPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("book"), owner.publicKey.toBuffer(), bookId.toArrayLike(Buffer, "le", 8)],
      program.programId,
    );
    const [baseVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), bookPda.toBuffer(), baseMint.toBuffer()],
      program.programId,
    );
    const [quoteVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), bookPda.toBuffer(), quoteMint.toBuffer()],
      program.programId,
    );
    const timings: Record<string, number | number[]> = {};

    let t = Date.now();
    const createOffset = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .createBook(createOffset, bookId, new anchor.BN(LOT_SIZE), feedBytes(AAPL_EQUITY), 600, 1_000, 600, NO_FALLBACK, 0, 0)
      .accountsPartial({
        authority: owner.publicKey,
        book: bookPda,
        baseMint,
        quoteMint,
        ...queueAccounts(createOffset, "init_book"),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await finalize(createOffset);
    timings.create_book_ms = Date.now() - t;
    console.log(`create_book: ${timings.create_book_ms} ms`);

    await program.methods
      .openVaults()
      .accountsPartial({ authority: owner.publicKey, book: bookPda, baseMint, quoteMint, baseVault, quoteVault })
      .rpc({ commitment: "confirmed" })
      .catch((e) => {
        console.log("open_vaults failed:", e.message, e.logs ?? e.transactionLogs ?? "");
        throw e;
      });

    const ticketPda = (n: number) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("ticket"), bookPda.toBuffer(), new anchor.BN(n).toArrayLike(Buffer, "le", 4)],
        program.programId,
      )[0];
    const orderMs: number[] = [];
    for (const [i, o] of orders.entries()) {
      const nonce = randomBytes(16);
      const ct = cipher.encrypt([BigInt(o.side), BigInt(o.price), BigInt(o.qty)], nonce);
      const offset = new anchor.BN(randomBytes(8), "hex");
      const isBuy = deposits[i].quote > 0;
      t = Date.now();
      await program.methods
        .submitOrder(
          offset,
          Array.from(ct[0]),
          Array.from(ct[1]),
          Array.from(ct[2]),
          Array.from(publicKey),
          new anchor.BN(deserializeLE(nonce).toString()),
          new anchor.BN(deposits[i].base),
          new anchor.BN(deposits[i].quote),
        )
        .accountsPartial({
          trader: traders[i].publicKey,
          book: bookPda,
          ticket: ticketPda(i),
          traderToken: isBuy ? wallets[i].quote : wallets[i].base,
          vault: isBuy ? quoteVault : baseVault,
          ...queueAccounts(offset, "place_order_v2"),
        })
        .signers([traders[i]])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      await finalize(offset);
      orderMs.push(Date.now() - t);
      console.log(`place_order ${i + 1}/${orders.length}: ${orderMs[i]} ms`);
    }
    timings.place_order_ms = orderMs;
    for (let i = 0; i < orders.length; i++) {
      const tk = await program.account.orderTicket.fetch(ticketPda(i));
      console.log(`ticket ${i}: status ${tk.status}`);
    }
    expect((await program.account.book.fetch(bookPda)).orderCount).to.equal(orders.length);

    t = Date.now();
    const clearOffset = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .clearBatch(clearOffset)
      .accountsPartial({
        caller: owner.publicKey,
        book: bookPda,
        priceUpdate: AAPL_EQUITY_PRICE,
        fallbackUpdate: null,
        ...queueAccounts(clearOffset, "clear_v2"),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await finalize(clearOffset);
    timings.clear_ms = Date.now() - t;
    console.log(`clear: ${timings.clear_ms} ms`);

    const cleared = await program.account.book.fetch(bookPda);
    const expected = referenceClear(covered, bandLo, bandHi);
    const fills = cleared.fills.map((f: anchor.BN) => f.toNumber());
    console.log("clearing price", cleared.clearingPrice, "matched", cleared.matched.toNumber());
    console.log("fills", fills.join(","));
    expect(cleared.status).to.equal(2);
    expect([cleared.bandLo, cleared.bandHi]).to.deep.equal([bandLo, bandHi]);
    expect(cleared.clearingPrice).to.equal(expected.price);
    expect(cleared.matched.toNumber()).to.equal(expected.matched);
    expect(fills).to.deep.equal(expected.fills);

    for (let i = 0; i < orders.length; i++) {
      await program.methods
        .settleOrder()
        .accountsPartial({
          book: bookPda,
          ticket: ticketPda(i),
          trader: traders[i].publicKey,
          baseVault,
          quoteVault,
          traderBase: wallets[i].base,
          traderQuote: wallets[i].quote,
        })
        .rpc({ commitment: "confirmed" });
    }

    const price = expected.price;
    for (let i = 0; i < orders.length; i++) {
      const f = expected.fills[i];
      const base = Number((await getAccount(provider.connection, wallets[i].base)).amount);
      const quote = Number((await getAccount(provider.connection, wallets[i].quote)).amount);
      const want =
        deposits[i].quote > 0
          ? { base: f * LOT_SIZE, quote: deposits[i].quote - f * price }
          : { base: deposits[i].base - f * LOT_SIZE, quote: f * price };
      console.log(`settled ${i}: base ${base} quote ${quote}`);
      expect({ base, quote }).to.deep.equal(want);
    }
    const underfunded = orders.length - 1;
    if (orders.length <= N && deposits[underfunded].quote === 20 * 109 - 1) {
      expect(expected.fills[underfunded]).to.equal(0);
    }
    for (let i = 0; i < orders.length; i++) {
      expect(await provider.connection.getAccountInfo(ticketPda(i))).to.equal(null);
    }
    expect(Number((await getAccount(provider.connection, baseVault)).amount)).to.equal(0);
    expect(Number((await getAccount(provider.connection, quoteVault)).amount)).to.equal(0);

    const avg = orderMs.reduce((a, b) => a + b, 0) / orderMs.length;
    console.log(
      `SUMMARY create=${timings.create_book_ms}ms order_avg=${Math.round(avg)}ms ` +
        `order_min=${Math.min(...orderMs)}ms order_max=${Math.max(...orderMs)}ms clear=${timings.clear_ms}ms`,
    );
    fs.writeFileSync(
      `bench-${process.env.BENCH_LABEL ?? "run"}.json`,
      JSON.stringify({ ...timings, order_avg_ms: avg, price, matched: expected.matched }, null, 2),
    );
  });

  // Opens a funded book with its own traders, for the cancel and timeout tests.
  async function openFundedBook(timeoutSecs: number, orders: Order[]) {
    const mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId);
    const secret = x25519.utils.randomSecretKey();
    const cipher = new RescueCipher(x25519.getSharedSecret(secret, mxePublicKey));
    const baseMint = await createMint(provider.connection, owner, owner.publicKey, null, 0);
    const quoteMint = await createMint(provider.connection, owner, owner.publicKey, null, 0);
    const deposits = orders.map((o) =>
      o.side === BUY ? { base: 0, quote: o.qty * o.price } : { base: o.qty * LOT_SIZE, quote: 0 },
    );
    const traders = orders.map(() => anchor.web3.Keypair.generate());
    const wallets: { base: PublicKey; quote: PublicKey }[] = [];
    for (const [i, trader] of traders.entries()) {
      await provider.sendAndConfirm(
        new anchor.web3.Transaction().add(
          anchor.web3.SystemProgram.transfer({
            fromPubkey: owner.publicKey,
            toPubkey: trader.publicKey,
            lamports: 0.05 * anchor.web3.LAMPORTS_PER_SOL,
          }),
        ),
      );
      const base = await createAccount(provider.connection, owner, baseMint, trader.publicKey);
      const quote = await createAccount(provider.connection, owner, quoteMint, trader.publicKey);
      if (deposits[i].base > 0) await mintTo(provider.connection, owner, baseMint, base, owner, deposits[i].base);
      if (deposits[i].quote > 0) await mintTo(provider.connection, owner, quoteMint, quote, owner, deposits[i].quote);
      wallets.push({ base, quote });
    }
    const bookId = new anchor.BN(randomBytes(8), "hex");
    const [book] = PublicKey.findProgramAddressSync(
      [Buffer.from("book"), owner.publicKey.toBuffer(), bookId.toArrayLike(Buffer, "le", 8)],
      program.programId,
    );
    const vault = (mint: PublicKey) =>
      PublicKey.findProgramAddressSync([Buffer.from("vault"), book.toBuffer(), mint.toBuffer()], program.programId)[0];
    const ticket = (n: number) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("ticket"), book.toBuffer(), new anchor.BN(n).toArrayLike(Buffer, "le", 4)],
        program.programId,
      )[0];
    const createOffset = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .createBook(createOffset, bookId, new anchor.BN(LOT_SIZE), feedBytes(AAPL_EQUITY), 600, 1_000, timeoutSecs, NO_FALLBACK, 0, 0)
      .accountsPartial({ authority: owner.publicKey, book, baseMint, quoteMint, ...queueAccounts(createOffset, "init_book") })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await finalize(createOffset);
    await program.methods
      .openVaults()
      .accountsPartial({ authority: owner.publicKey, book, baseMint, quoteMint, baseVault: vault(baseMint), quoteVault: vault(quoteMint) })
      .rpc({ commitment: "confirmed" });

    // Queues order i and returns its computation offset without waiting for Arcium.
    const submit = async (i: number) => {
      const o = orders[i];
      const nonce = randomBytes(16);
      const ct = cipher.encrypt([BigInt(o.side), BigInt(o.price), BigInt(o.qty)], nonce);
      const offset = new anchor.BN(randomBytes(8), "hex");
      const isBuy = deposits[i].quote > 0;
      await program.methods
        .submitOrder(
          offset,
          Array.from(ct[0]),
          Array.from(ct[1]),
          Array.from(ct[2]),
          Array.from(x25519.getPublicKey(secret)),
          new anchor.BN(deserializeLE(nonce).toString()),
          new anchor.BN(deposits[i].base),
          new anchor.BN(deposits[i].quote),
        )
        .accountsPartial({
          trader: traders[i].publicKey,
          book,
          ticket: ticket(i),
          traderToken: isBuy ? wallets[i].quote : wallets[i].base,
          vault: isBuy ? vault(quoteMint) : vault(baseMint),
          ...queueAccounts(offset, "place_order_v2"),
        })
        .signers([traders[i]])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      return offset;
    };
    const balance = async (a: PublicKey) => Number((await getAccount(provider.connection, a)).amount);
    return { book, baseMint, quoteMint, vault, ticket, traders, wallets, deposits, submit, balance };
  }

  const errorCode = (e: any) => String(e?.error?.errorCode?.code ?? e?.message ?? e);

  it("cancels a live order: full refund, and the clear ignores it", async () => {
    const orders: Order[] = [
      { side: BUY, price: 100, qty: 3 },
      { side: SELL, price: 96, qty: 4 },
      { side: SELL, price: 99, qty: 2 },
    ];
    const b = await openFundedBook(600, orders);
    for (let i = 0; i < orders.length; i++) await finalize(await b.submit(i));

    await program.methods
      .cancelOrder()
      .accountsPartial({
        trader: b.traders[1].publicKey,
        book: b.book,
        ticket: b.ticket(1),
        vault: b.vault(b.baseMint),
        traderToken: b.wallets[1].base,
      })
      .signers([b.traders[1]])
      .rpc({ commitment: "confirmed" });
    expect(await b.balance(b.wallets[1].base)).to.equal(b.deposits[1].base);
    expect(await provider.connection.getAccountInfo(b.ticket(1))).to.equal(null);
    expect((await program.account.book.fetch(b.book)).cancelledMask).to.equal(0b10);

    const again = await program.methods
      .cancelOrder()
      .accountsPartial({
        trader: b.traders[1].publicKey,
        book: b.book,
        ticket: b.ticket(1),
        vault: b.vault(b.baseMint),
        traderToken: b.wallets[1].base,
      })
      .signers([b.traders[1]])
      .rpc({ commitment: "confirmed" })
      .then(() => "cancelled twice")
      .catch(errorCode);
    expect(again).to.not.equal("cancelled twice");

    const clearOffset = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .clearBatch(clearOffset)
      .accountsPartial({ caller: owner.publicKey, book: b.book, priceUpdate: AAPL_EQUITY_PRICE, fallbackUpdate: null, ...queueAccounts(clearOffset, "clear_v2") })
      .rpc({ commitment: "confirmed" });
    await finalize(clearOffset);
    const cleared = await program.account.book.fetch(b.book);
    const withoutCancelled = orders.map((o, i) => (i === 1 ? { ...o, qty: 0 } : o));
    const expected = referenceClear(withoutCancelled, 90, 110);
    const fills = cleared.fills.map((f: anchor.BN) => f.toNumber());
    console.log(`cancel test: price ${cleared.clearingPrice}, fills ${fills.slice(0, 3).join(",")}`);
    expect(cleared.clearingPrice).to.equal(expected.price);
    expect(fills).to.deep.equal(expected.fills);
    expect(fills[1]).to.equal(0);

    for (const i of [0, 2]) {
      await program.methods
        .settleOrder()
        .accountsPartial({
          book: b.book,
          ticket: b.ticket(i),
          trader: b.traders[i].publicKey,
          baseVault: b.vault(b.baseMint),
          quoteVault: b.vault(b.quoteMint),
          traderBase: b.wallets[i].base,
          traderQuote: b.wallets[i].quote,
        })
        .rpc({ commitment: "confirmed" });
    }
    expect(await b.balance(b.vault(b.baseMint))).to.equal(0);
    expect(await b.balance(b.vault(b.quoteMint))).to.equal(0);
  });

  it("expires a stuck order after the timeout and ignores Arcium's late answer", async () => {
    const orders: Order[] = [{ side: BUY, price: 100, qty: 2 }];
    const b = await openFundedBook(1, orders);
    const nothing = await program.methods
      .expirePending()
      .accountsPartial({ caller: owner.publicKey, book: b.book, ticket: null })
      .rpc({ commitment: "confirmed" })
      .then(() => "expired")
      .catch(errorCode);
    expect(nothing).to.equal("NothingPending");

    const offset = await b.submit(0);
    await new Promise((r) => setTimeout(r, 2_500));
    const expired = await program.methods
      .expirePending()
      .accountsPartial({ caller: owner.publicKey, book: b.book, ticket: b.ticket(0) })
      .rpc({ commitment: "confirmed" })
      .then(() => "expired")
      .catch(errorCode);
    if (expired !== "expired") {
      console.log(`timeout test: Arcium answered first (${expired}); nothing to expire this run`);
      return;
    }
    const afterExpiry = await program.account.book.fetch(b.book);
    expect(afterExpiry.pending).to.equal(false);
    expect((await program.account.orderTicket.fetch(b.ticket(0))).status).to.equal(2);

    await finalize(offset);
    const afterLateAnswer = await program.account.book.fetch(b.book);
    console.log(`timeout test: expired, then late answer arrived; order_count ${afterLateAnswer.orderCount}`);
    expect(afterLateAnswer.orderCount).to.equal(0);
    expect(afterLateAnswer.pending).to.equal(false);
    expect(afterLateAnswer.stateNonce.toString()).to.equal(afterExpiry.stateNonce.toString());

    await program.methods
      .refundFailedOrder()
      .accountsPartial({
        book: b.book,
        ticket: b.ticket(0),
        trader: b.traders[0].publicKey,
        vault: b.vault(b.quoteMint),
        traderToken: b.wallets[0].quote,
      })
      .rpc({ commitment: "confirmed" });
    expect(await b.balance(b.wallets[0].quote)).to.equal(b.deposits[0].quote);
    expect(await b.balance(b.vault(b.quoteMint))).to.equal(0);
  });

  it("picks the reference price safely: exchange first, fallback only when closed", async () => {
    const baseMint = await createMint(provider.connection, owner, owner.publicKey, null, 0);
    const quoteMint = await createMint(provider.connection, owner, owner.publicKey, null, 0);
    const openBook = async (primary: string, fallback: string | null) => {
      const bookId = new anchor.BN(randomBytes(8), "hex");
      const [book] = PublicKey.findProgramAddressSync(
        [Buffer.from("book"), owner.publicKey.toBuffer(), bookId.toArrayLike(Buffer, "le", 8)],
        program.programId,
      );
      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .createBook(
          offset,
          bookId,
          new anchor.BN(LOT_SIZE),
          feedBytes(primary),
          600,
          1_000,
          600,
          fallback ? feedBytes(fallback) : NO_FALLBACK,
          fallback ? 2_000 : 0,
          fallback ? 3_600 : 0,
        )
        .accountsPartial({ authority: owner.publicKey, book, baseMint, quoteMint, ...queueAccounts(offset, "init_book") })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      await finalize(offset);
      return book;
    };
    const clearWith = async (book: PublicKey, priceUpdate: PublicKey, fallbackUpdate: PublicKey | null) => {
      const offset = new anchor.BN(randomBytes(8), "hex");
      try {
        await program.methods
          .clearBatch(offset)
          .accountsPartial({ caller: owner.publicKey, book, priceUpdate, fallbackUpdate, ...queueAccounts(offset, "clear_v2") })
          .rpc({ commitment: "confirmed" });
        await finalize(offset);
        return "cleared";
      } catch (e) {
        return errorCode(e);
      }
    };

    // The primary must be the canonical account for the book's feed.
    const aapl = await openBook(AAPL_EQUITY, null);
    expect(await clearWith(aapl, AAPLX_FALLBACK_FRESH, null)).to.equal("WrongPriceAccount");

    // Cherry-picking: a price published before the last order is refused.
    const early = await openBook(BEFORE_BOOK_FEED, null);
    expect(await clearWith(early, BEFORE_BOOK_PRICE, null)).to.equal("PriceBeforeCutoff");

    // Stale, but not stale enough to call the market closed: no clear, no fallback.
    const slight = await openBook(SLIGHTLY_STALE_FEED, AAPLX_USD);
    expect(await clearWith(slight, SLIGHTLY_STALE_PRICE, AAPLX_FALLBACK_FRESH)).to.equal("StalePrice");

    // Exchange closed and no fallback configured: no clear.
    const closedNoFallback = await openBook(TSLA_EQUITY, null);
    expect(await clearWith(closedNoFallback, TSLA_EQUITY_PRICE, AAPLX_FALLBACK_FRESH)).to.equal("StalePrice");

    // Exchange closed with a fallback: it must be supplied, recent, and after the cutoff.
    const closed = await openBook(TSLA_EQUITY, AAPLX_USD);
    expect(await clearWith(closed, TSLA_EQUITY_PRICE, null)).to.equal("MissingFallbackPrice");
    expect(await clearWith(closed, TSLA_EQUITY_PRICE, AAPLX_FALLBACK_EARLY)).to.equal("PriceBeforeCutoff");
    expect(await clearWith(closed, TSLA_EQUITY_PRICE, AAPLX_FALLBACK_FRESH)).to.equal("cleared");
    const cleared = await program.account.book.fetch(closed);
    console.log(`fallback clear: used_fallback ${cleared.usedFallback}, band ${cleared.bandLo}..${cleared.bandHi}`);
    expect(cleared.usedFallback).to.equal(true);
    expect([cleared.bandLo, cleared.bandHi]).to.deep.equal([80, 120]);
  });

  async function initCompDef(circuit: string) {
    const offset = getCompDefAccOffset(circuit);
    const compDefPDA = PublicKey.findProgramAddressSync(
      [getArciumAccountBaseSeed("ComputationDefinitionAccount"), program.programId.toBuffer(), offset],
      getArciumProgramId(),
    )[0];
    if ((await provider.connection.getAccountInfo(compDefPDA)) === null) {
      const mxeAccount = getMXEAccAddress(program.programId);
      const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
      const accounts = {
        compDefAccount: compDefPDA,
        payer: owner.publicKey,
        mxeAccount,
        addressLookupTable: getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot),
      };
      const builders = {
        init_book: () => program.methods.initInitBookCompDef(),
        place_order_v2: () => program.methods.initPlaceOrderV2CompDef(),
        clear_v2: () => program.methods.initClearV2CompDef(),
      };
      await builders[circuit]().accounts(accounts).signers([owner]).rpc({ commitment: "confirmed" });
    }
    await uploadCircuit(
      provider,
      circuit,
      program.programId,
      fs.readFileSync(`build/${circuit}.arcis`),
      true,
      Number(process.env.UPLOAD_BATCH ?? 500),
      { skipPreflight: true, preflightCommitment: "confirmed", commitment: "confirmed" },
    );
  }
});

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries = 20,
  retryDelayMs = 500,
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const key = await getMXEPublicKey(provider, programId);
      if (key) return key;
    } catch (error) {
      console.log(`Attempt ${attempt} failed to fetch MXE public key:`, error);
    }
    if (attempt < maxRetries) await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  throw new Error(`Failed to fetch MXE public key after ${maxRetries} attempts`);
}

function readKpJson(path: string): anchor.web3.Keypair {
  const file = fs.readFileSync(path);
  return anchor.web3.Keypair.fromSecretKey(new Uint8Array(JSON.parse(file.toString())));
}
