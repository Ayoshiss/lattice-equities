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

const N = 16;
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

  it("clears a 16-order encrypted batch and records timings", async () => {
    const mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId);
    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const cipher = new RescueCipher(x25519.getSharedSecret(privateKey, mxePublicKey));

    const orders: Order[] = [];
    for (let k = 0; k < 8; k++) {
      orders.push({ side: BUY, price: 100 + k, qty: 3 + k });
      orders.push({ side: SELL, price: 96 + k, qty: 4 + k });
    }
    const bandLo = 95;
    const bandHi = 110;

    const bookId = new anchor.BN(randomBytes(8), "hex");
    const [bookPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("book"), owner.publicKey.toBuffer(), bookId.toArrayLike(Buffer, "le", 8)],
      program.programId,
    );
    const timings: Record<string, number | number[]> = {};

    let t = Date.now();
    const createOffset = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .createBook(createOffset, bookId)
      .accountsPartial({ authority: owner.publicKey, book: bookPda, ...queueAccounts(createOffset, "init_book") })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await finalize(createOffset);
    timings.create_book_ms = Date.now() - t;
    console.log(`create_book: ${timings.create_book_ms} ms`);

    const orderMs: number[] = [];
    for (const [i, o] of orders.entries()) {
      const nonce = randomBytes(16);
      const ct = cipher.encrypt([BigInt(o.side), BigInt(o.price), BigInt(o.qty)], nonce);
      const offset = new anchor.BN(randomBytes(8), "hex");
      t = Date.now();
      await program.methods
        .submitOrder(
          offset,
          Array.from(ct[0]),
          Array.from(ct[1]),
          Array.from(ct[2]),
          Array.from(publicKey),
          new anchor.BN(deserializeLE(nonce).toString()),
        )
        .accountsPartial({ trader: owner.publicKey, book: bookPda, ...queueAccounts(offset, "place_order") })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      await finalize(offset);
      orderMs.push(Date.now() - t);
      console.log(`place_order ${i + 1}/${orders.length}: ${orderMs[i]} ms`);
    }
    timings.place_order_ms = orderMs;

    const book = await program.account.book.fetch(bookPda);
    expect(book.orderCount).to.equal(orders.length);

    t = Date.now();
    const clearOffset = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .clearBatch(clearOffset, bandLo, bandHi)
      .accountsPartial({ caller: owner.publicKey, book: bookPda, ...queueAccounts(clearOffset, "clear") })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await finalize(clearOffset);
    timings.clear_ms = Date.now() - t;
    console.log(`clear: ${timings.clear_ms} ms`);

    const cleared = await program.account.book.fetch(bookPda);
    const expected = referenceClear(orders, bandLo, bandHi);
    const fills = cleared.fills.map((f: anchor.BN) => f.toNumber());
    console.log("clearing price", cleared.clearingPrice, "matched", cleared.matched.toNumber());
    console.log("fills", fills.join(","));
    expect(cleared.status).to.equal(2);
    expect(cleared.clearingPrice).to.equal(expected.price);
    expect(cleared.matched.toNumber()).to.equal(expected.matched);
    expect(fills).to.deep.equal(expected.fills);

    const avg = orderMs.reduce((a, b) => a + b, 0) / orderMs.length;
    console.log(
      `SUMMARY create=${timings.create_book_ms}ms order_avg=${Math.round(avg)}ms ` +
        `order_min=${Math.min(...orderMs)}ms order_max=${Math.max(...orderMs)}ms clear=${timings.clear_ms}ms`,
    );
    fs.writeFileSync(
      `bench-${process.env.BENCH_LABEL ?? "run"}.json`,
      JSON.stringify({ ...timings, order_avg_ms: avg, price: cleared.clearingPrice, matched: expected.matched }, null, 2),
    );
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
