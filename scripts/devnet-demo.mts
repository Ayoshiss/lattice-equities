// End-to-end run on devnet: register circuits, open a book on a Pyth feed, submit
// encrypted orders through the paid x402 relay, clear against a freshly posted
// Pyth price, and settle every order.
//
//   RPC=<devnet rpc> PYTH_API_KEY=<key> FEED=TSLA npx tsx scripts/devnet-demo.mts
//
// FEED picks the Pyth reference: TSLA (US equity, updates in market hours
// only), AAPLX (24/7 xStock price) or SOL (24/7, for testing the pipeline).
//
// The wallet at ~/.config/solana/id.json is the book authority, funds the test
// traders, and pays the relay's x402 fee in devnet USDC.

import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
// Under ESM, BN is only on the package's default export.
const BN: any = (anchor as any).default?.BN ?? (anchor as any).BN;
import { Keypair, PublicKey } from "@solana/web3.js";
import { createAccount, createMint, getAccount, mintTo } from "@solana/spl-token";
import {
  awaitComputationFinalization,
  deserializeLE,
  getArciumAccountBaseSeed,
  getArciumProgram,
  getArciumProgramId,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getExecutingPoolAccAddress,
  getLookupTableAddress,
  getMempoolAccAddress,
  getMXEAccAddress,
  getMXEPublicKey,
  RescueCipher,
  x25519,
} from "@arcium-hq/client";
import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { wrapFetchWithPayment } from "x402-fetch";
import { createSigner } from "x402/types";
import bs58 from "bs58";
import { randomBytes } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";

const RPC = process.env.RPC!;
const RELAY_URL = process.env.RELAY_URL ?? "http://localhost:4402";
const CLUSTER_OFFSET = 456;
const FEEDS: Record<string, string> = {
  TSLA: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
  AAPLX: "978e6cc68a119ce066aa830017318563a9ed04ec3a0a6439010fc11296a58675",
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
};
const FEED_NAME = process.env.FEED ?? "TSLA";
const FEED_ID = FEEDS[FEED_NAME];
if (!FEED_ID) throw new Error(`FEED must be one of ${Object.keys(FEEDS).join(", ")}`);
const BASE_DECIMALS = 8;
const QUOTE_DECIMALS = 6;
const LOT_SIZE = 10 ** BASE_DECIMALS; // one share per lot
const BUY = 1;
const SELL = 0;

const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))));
const connection = new anchor.web3.Connection(RPC, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), { commitment: "confirmed" });
anchor.setProvider(provider);
const idl = JSON.parse(readFileSync("target/idl/lattice_equities.json", "utf8"));
const program = new Program(idl, provider) as Program<any>;
const arcium = getArciumProgram(provider);
const clusterAccount = getClusterAccAddress(CLUSTER_OFFSET);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const queueAccounts = (offset: any, circuit: string) => ({
  computationAccount: getComputationAccAddress(CLUSTER_OFFSET, offset),
  clusterAccount,
  mxeAccount: getMXEAccAddress(program.programId),
  mempoolAccount: getMempoolAccAddress(CLUSTER_OFFSET),
  executingPool: getExecutingPoolAccAddress(CLUSTER_OFFSET),
  compDefAccount: getCompDefAccAddress(program.programId, Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE()),
});
const finalize = (offset: any) => awaitComputationFinalization(provider, offset, program.programId, "confirmed");

async function registerCircuits() {
  const builders: Record<string, () => any> = {
    init_book: () => program.methods.initInitBookCompDef(),
    place_order_v2: () => program.methods.initPlaceOrderV2CompDef(),
    clear_v2: () => program.methods.initClearV2CompDef(),
  };
  const mxeAccount = getMXEAccAddress(program.programId);
  const mxe = await arcium.account.mxeAccount.fetch(mxeAccount);
  for (const circuit of Object.keys(builders)) {
    const compDef = PublicKey.findProgramAddressSync(
      [getArciumAccountBaseSeed("ComputationDefinitionAccount"), program.programId.toBuffer(), getCompDefAccOffset(circuit)],
      getArciumProgramId(),
    )[0];
    if (await connection.getAccountInfo(compDef)) continue;
    await builders[circuit]()
      .accounts({
        compDefAccount: compDef,
        payer: owner.publicKey,
        mxeAccount,
        addressLookupTable: getLookupTableAddress(program.programId, mxe.lutOffsetSlot),
      })
      .rpc({ commitment: "confirmed" });
    log(`registered ${circuit}`);
  }
}

async function fund(to: PublicKey, sol: number) {
  await provider.sendAndConfirm(
    new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: to, lamports: sol * anchor.web3.LAMPORTS_PER_SOL }),
    ),
  );
}

async function main() {
  const timings: Record<string, unknown> = {};
  await registerCircuits();

  // Hermes has required an API key since the Pyth Core upgrade (Aug 2026).
  if (!process.env.PYTH_API_KEY) throw new Error("set PYTH_API_KEY (Pyth Terminal)");
  const hermes = new HermesClient("https://hermes.pyth.network", { accessToken: process.env.PYTH_API_KEY });
  const latest = await hermes.getLatestPriceUpdates([FEED_ID]);
  const p = latest.parsed![0].price;
  const usd = Number(p.price) * 10 ** p.expo;
  const perLot = (x: number) => Math.round(usd * x * 10 ** QUOTE_DECIMALS);
  log(`${FEED_NAME}/USD from Hermes: $${usd.toFixed(4)}`);

  // Two buyers above the price, two sellers below it; all within the 2% band.
  const orders = [
    { side: BUY, price: perLot(1.005), qty: 3 },
    { side: SELL, price: perLot(0.995), qty: 2 },
    { side: BUY, price: perLot(1.01), qty: 1 },
    { side: SELL, price: perLot(0.99), qty: 3 },
  ];
  const deposits = orders.map((o) =>
    o.side === BUY ? { base: 0, quote: o.qty * o.price } : { base: o.qty * LOT_SIZE, quote: 0 },
  );

  const baseMint = await createMint(connection, owner, owner.publicKey, null, BASE_DECIMALS);
  const quoteMint = await createMint(connection, owner, owner.publicKey, null, QUOTE_DECIMALS);
  const traders = orders.map(() => Keypair.generate());
  const wallets: { base: PublicKey; quote: PublicKey }[] = [];
  for (const [i, t] of traders.entries()) {
    await fund(t.publicKey, 0.05);
    const base = await createAccount(connection, owner, baseMint, t.publicKey);
    const quote = await createAccount(connection, owner, quoteMint, t.publicKey);
    if (deposits[i].base) await mintTo(connection, owner, baseMint, base, owner, deposits[i].base);
    if (deposits[i].quote) await mintTo(connection, owner, quoteMint, quote, owner, deposits[i].quote);
    wallets.push({ base, quote });
  }
  log(`test tokens: base ${baseMint.toBase58()} quote ${quoteMint.toBase58()}`);

  const bookId = new BN(randomBytes(8), "hex");
  const [book] = PublicKey.findProgramAddressSync(
    [Buffer.from("book"), owner.publicKey.toBuffer(), bookId.toArrayLike(Buffer, "le", 8)],
    program.programId,
  );
  const vault = (mint: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("vault"), book.toBuffer(), mint.toBuffer()], program.programId)[0];
  const ticket = (n: number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), book.toBuffer(), new BN(n).toArrayLike(Buffer, "le", 4)],
      program.programId,
    )[0];

  let t0 = Date.now();
  const createOffset = new BN(randomBytes(8), "hex");
  await program.methods
    .createBook(
      createOffset,
      bookId,
      new BN(LOT_SIZE),
      Array.from(Buffer.from(FEED_ID, "hex")),
      120,
      200,
      600,
      new Array(32).fill(0),
      0,
      0,
    )
    .accountsPartial({ authority: owner.publicKey, book, baseMint, quoteMint, ...queueAccounts(createOffset, "init_book") })
    .rpc({ skipPreflight: true, commitment: "confirmed" });
  await finalize(createOffset);
  timings.create_book_ms = Date.now() - t0;
  await program.methods
    .openVaults()
    .accountsPartial({ authority: owner.publicKey, book, baseMint, quoteMint, baseVault: vault(baseMint), quoteVault: vault(quoteMint) })
    .rpc({ commitment: "confirmed" });
  log(`book ${book.toBase58()} ready in ${timings.create_book_ms} ms`);

  // Orders go through the relay. The agent operator pays the x402 fee in USDC;
  // each trader signs their own submit_order, so the relay never holds funds.
  const payer = await createSigner("solana-devnet", bs58.encode(owner.secretKey));
  const paidFetch = wrapFetchWithPayment(fetch, payer, undefined, undefined, { svmConfig: { rpcUrl: RPC } });
  const mxeKey = await getMXEPublicKey(provider, program.programId);
  const secret = x25519.utils.randomSecretKey();
  const cipher = new RescueCipher(x25519.getSharedSecret(secret, mxeKey!));
  const orderMs: number[] = [];
  const relayTxs: string[] = [];
  for (const [i, o] of orders.entries()) {
    const nonce = randomBytes(16);
    const ct = cipher.encrypt([BigInt(o.side), BigInt(o.price), BigInt(o.qty)], nonce);
    const offset = new BN(randomBytes(8), "hex");
    const isBuy = deposits[i].quote > 0;
    const tx = await program.methods
      .submitOrder(
        offset,
        Array.from(ct[0]),
        Array.from(ct[1]),
        Array.from(ct[2]),
        Array.from(x25519.getPublicKey(secret)),
        new BN(deserializeLE(nonce).toString()),
        new BN(deposits[i].base),
        new BN(deposits[i].quote),
      )
      .accountsPartial({
        trader: traders[i].publicKey,
        book,
        ticket: ticket(i),
        traderToken: isBuy ? wallets[i].quote : wallets[i].base,
        vault: isBuy ? vault(quoteMint) : vault(baseMint),
        ...queueAccounts(offset, "place_order_v2"),
      })
      .transaction();
    tx.feePayer = traders[i].publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(traders[i]);

    t0 = Date.now();
    const res = await paidFetch(`${RELAY_URL}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction: tx.serialize().toString("base64") }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`relay refused order ${i + 1}: ${res.status} ${JSON.stringify(body)}`);
    const receipt = res.headers.get("x-payment-response");
    const paid = receipt ? JSON.parse(Buffer.from(receipt, "base64").toString()).transaction : "none";
    relayTxs.push(paid);
    await finalize(offset);
    orderMs.push(Date.now() - t0);
    log(`order ${i + 1} via relay in ${orderMs[i]} ms (order tx ${body.signature.slice(0, 8)}…, fee tx ${String(paid).slice(0, 8)}…)`);
  }
  timings.order_ms = orderMs;

  // Refresh the feed's canonical Pyth account with a verified update published
  // after the last order, then clear against it. Anyone can do this refresh.
  const receiver = new PythSolanaReceiver({ connection, wallet: new anchor.Wallet(owner) as any });
  const update = await hermes.getLatestPriceUpdates([FEED_ID], { encoding: "base64" });
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await builder.addUpdatePriceFeed(update.binary.data, 0);
  const priceUpdate = receiver.getPriceFeedAccountAddress(0, "0x" + FEED_ID);
  await receiver.provider.sendAll(await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 50_000 }), {
    skipPreflight: true,
  });
  log(`posted Pyth update ${priceUpdate.toBase58()}`);

  t0 = Date.now();
  const clearOffset = new BN(randomBytes(8), "hex");
  await program.methods
    .clearBatch(clearOffset)
    .accountsPartial({ caller: owner.publicKey, book, priceUpdate, fallbackUpdate: null, ...queueAccounts(clearOffset, "clear_v2") })
    .rpc({ commitment: "confirmed" });
  await finalize(clearOffset);
  timings.clear_ms = Date.now() - t0;
  const cleared = await (program.account as any).book.fetch(book);
  const fills = cleared.fills.slice(0, orders.length).map((f: any) => f.toNumber());
  log(
    `cleared in ${timings.clear_ms} ms at ${cleared.clearingPrice} per lot ($${(cleared.clearingPrice / 10 ** QUOTE_DECIMALS).toFixed(4)}),` +
      ` band ${cleared.bandLo}..${cleared.bandHi}, matched ${cleared.matched.toNumber()} lots, fills ${fills.join(",")}`,
  );

  for (let i = 0; i < orders.length; i++) {
    await program.methods
      .settleOrder()
      .accountsPartial({
        book,
        ticket: ticket(i),
        trader: traders[i].publicKey,
        baseVault: vault(baseMint),
        quoteVault: vault(quoteMint),
        traderBase: wallets[i].base,
        traderQuote: wallets[i].quote,
      })
      .rpc({ commitment: "confirmed" });
    const base = Number((await getAccount(connection, wallets[i].base)).amount) / LOT_SIZE;
    const quote = Number((await getAccount(connection, wallets[i].quote)).amount) / 10 ** QUOTE_DECIMALS;
    log(`settled ${orders[i].side === BUY ? "buy " : "sell"} ${i + 1}: ${base} shares, ${quote.toFixed(2)} quote`);
  }
  const vaultsEmpty =
    Number((await getAccount(connection, vault(baseMint))).amount) === 0 &&
    Number((await getAccount(connection, vault(quoteMint))).amount) === 0;
  log(`vaults empty: ${vaultsEmpty}`);

  writeFileSync(
    "bench-devnet-e2e.json",
    JSON.stringify(
      { ...timings, feed: FEED_NAME, reference_usd: usd, clearing_price_per_lot: cleared.clearingPrice, matched: cleared.matched.toNumber(), fills, book: book.toBase58(), relay_fee_txs: relayTxs },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
