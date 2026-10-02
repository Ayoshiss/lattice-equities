// Paid order relay for Lattice Equities.
//
// POST /orders costs a small USDC fee through standard x402 (exact scheme,
// solana-devnet), so any x402 client, including `pay curl`, can use it. The
// body is the trader's own signed submit_order transaction: the relay never
// holds the trader's keys or tokens, it checks the transaction only calls the
// Lattice Equities program and forwards it.
//
// The facilitator runs in-process on PORT + 1 and uses the official x402
// verify/settle, which reject payments that move the wrong amount, pay the
// wrong account, or try to make the relay's fee payer spend its own funds.

import express from "express";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import bs58 from "bs58";
import { address } from "@solana/kit";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { paymentMiddleware } from "x402-express";
import { settle, verify } from "x402/facilitator";
import { createSigner } from "x402/types";

const NETWORK = "solana-devnet";
const PORT = Number(process.env.PORT ?? 4402);
const PRICE = process.env.ORDER_PRICE ?? "$0.001";
const RPC_URL = process.env.RPC_URL;
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? "AUXkwEowRX7BMPXGF1Ak2nC9Ni5SML7EU6fB6Jo1zvgm");
const SUBMIT_ORDER = createHash("sha256").update("global:submit_order").digest().subarray(0, 8);

if (!RPC_URL) throw new Error("set RPC_URL to a devnet RPC endpoint");
const relayKey = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(process.env.RELAY_KEYPAIR ?? "relay-keypair.json", "utf8"))),
);
const connection = new Connection(RPC_URL, "confirmed");
const x402Config = { svmConfig: { rpcUrl: RPC_URL } };

async function startFacilitator(port: number) {
  const signer = await createSigner(NETWORK, bs58.encode(relayKey.secretKey));
  const app = express();
  app.use(express.json());
  app.get("/supported", (_req, res) => {
    res.json({
      kinds: [{ x402Version: 1, scheme: "exact", network: NETWORK, extra: { feePayer: relayKey.publicKey.toBase58() } }],
    });
  });
  app.post("/verify", async (req, res) => {
    try {
      res.json(await verify(signer, req.body.paymentPayload, req.body.paymentRequirements, x402Config));
    } catch (e) {
      res.json({ isValid: false, invalidReason: String(e) });
    }
  });
  app.post("/settle", async (req, res) => {
    try {
      res.json(await settle(signer, req.body.paymentPayload, req.body.paymentRequirements, x402Config));
    } catch (e) {
      res.json({ success: false, errorReason: String(e), transaction: "", network: NETWORK });
    }
  });
  await new Promise<void>((resolve) => app.listen(port, "127.0.0.1", () => resolve()));
}

// Only forward a transaction that is a single Lattice Equities submit_order,
// optionally with compute-budget instructions, paid for by the trader.
function checkOrder(tx: VersionedTransaction): string | null {
  const msg = tx.message;
  if (msg.addressTableLookups.length > 0) return "address lookup tables are not accepted";
  const keys = msg.staticAccountKeys;
  if (keys[0].equals(relayKey.publicKey)) return "the relay does not pay for orders";
  let orders = 0;
  for (const ix of msg.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (program.equals(ComputeBudgetProgram.programId)) continue;
    if (!program.equals(PROGRAM_ID)) return `instruction for another program: ${program.toBase58()}`;
    if (!Buffer.from(ix.data.subarray(0, 8)).equals(SUBMIT_ORDER)) return "only submit_order is accepted";
    orders++;
  }
  if (orders !== 1) return "expected exactly one submit_order";
  const unsigned = tx.signatures.slice(0, msg.header.numRequiredSignatures).some((s) => s.every((b) => b === 0));
  if (unsigned) return "transaction is not fully signed";
  return null;
}

async function main() {
  const facilitatorPort = PORT + 1;
  await startFacilitator(facilitatorPort);

  const app = express();
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, program: PROGRAM_ID.toBase58(), payTo: relayKey.publicKey.toBase58(), price: PRICE });
  });

  app.use(
    paymentMiddleware(
      address(relayKey.publicKey.toBase58()),
      {
        "POST /orders": {
          price: PRICE,
          network: NETWORK,
          config: {
            description: "Submit an encrypted Lattice Equities order (signed submit_order transaction)",
            mimeType: "application/json",
          },
        },
      },
      { url: `http://127.0.0.1:${facilitatorPort}` },
    ),
  );

  app.post("/orders", async (req, res) => {
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(Buffer.from(String(req.body?.transaction ?? ""), "base64"));
    } catch {
      res.status(400).json({ error: "body must be { transaction: <base64 signed transaction> }" });
      return;
    }
    const problem = checkOrder(tx);
    if (problem) {
      res.status(400).json({ error: problem });
      return;
    }
    try {
      const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await connection.confirmTransaction(signature, "confirmed");
      res.json({ signature, explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet` });
    } catch (e) {
      res.status(422).json({ error: `order transaction failed: ${e instanceof Error ? e.message : e}` });
    }
  });

  app.listen(PORT, () => {
    console.log(`relay on :${PORT}, orders cost ${PRICE} USDC on ${NETWORK}, pay to ${relayKey.publicKey.toBase58()}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
