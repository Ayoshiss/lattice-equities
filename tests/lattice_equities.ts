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
const PYTH_FRESH = new PublicKey("H1PFU9pRg879bM4TBUsr11igtAdt1xU7zHL673jg8hsJ");
const PYTH_STALE = new PublicKey("FDWVP2C1f7iYugmnYCdBE91Gw91wQsboiQ2ET2V9c5JQ");
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
    for (const circuit of ["init_book", "place_order", "clear"]) {
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
    const orders = allOrders.slice(0, Number(process.env.BENCH_ORDERS ?? 4));
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
      .createBook(createOffset, bookId, new anchor.BN(LOT_SIZE), feedBytes(AAPLX_USD), 600, 1_000)
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
          ...queueAccounts(offset, "place_order"),
        })
        .signers([traders[i]])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      await finalize(offset);
      orderMs.push(Date.now() - t);
      console.log(`place_order ${i + 1}/${orders.length}: ${orderMs[i]} ms`);
    }
    timings.place_order_ms = orderMs;
    expect((await program.account.book.fetch(bookPda)).orderCount).to.equal(orders.length);

    t = Date.now();
    const clearOffset = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .clearBatch(clearOffset)
      .accountsPartial({
        caller: owner.publicKey,
        book: bookPda,
        priceUpdate: PYTH_FRESH,
        ...queueAccounts(clearOffset, "clear"),
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

  it("refuses to clear on a stale price or another stock's feed", async () => {
    const baseMint = await createMint(provider.connection, owner, owner.publicKey, null, 0);
    const quoteMint = await createMint(provider.connection, owner, owner.publicKey, null, 0);
    const openBook = async (feed: string) => {
      const bookId = new anchor.BN(randomBytes(8), "hex");
      const [book] = PublicKey.findProgramAddressSync(
        [Buffer.from("book"), owner.publicKey.toBuffer(), bookId.toArrayLike(Buffer, "le", 8)],
        program.programId,
      );
      const offset = new anchor.BN(randomBytes(8), "hex");
      await program.methods
        .createBook(offset, bookId, new anchor.BN(LOT_SIZE), feedBytes(feed), 600, 1_000)
        .accountsPartial({ authority: owner.publicKey, book, baseMint, quoteMint, ...queueAccounts(offset, "init_book") })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      await finalize(offset);
      return book;
    };
    const clearWith = async (book: PublicKey, priceUpdate: PublicKey) => {
      const offset = new anchor.BN(randomBytes(8), "hex");
      try {
        await program.methods
          .clearBatch(offset)
          .accountsPartial({ caller: owner.publicKey, book, priceUpdate, ...queueAccounts(offset, "clear") })
          .rpc({ commitment: "confirmed" });
        return "cleared";
      } catch (e) {
        return String(e.error?.errorCode?.code ?? e.message);
      }
    };

    const aaplx = await openBook(AAPLX_USD);
    expect(await clearWith(aaplx, PYTH_STALE)).to.equal("StalePrice");
    const equity = await openBook(AAPL_EQUITY);
    expect(await clearWith(equity, PYTH_FRESH)).to.equal("WrongPriceFeed");
    expect(await clearWith(aaplx, owner.publicKey)).to.equal("BadPriceAccount");
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
        place_order: () => program.methods.initPlaceOrderCompDef(),
        clear: () => program.methods.initClearCompDef(),
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
