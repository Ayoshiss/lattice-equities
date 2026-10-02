// Writes Pyth PriceUpdateV2 accounts for the local test validator. Pyth does not
// run on localnet, so these stand in for real updates, one per scenario the tests
// check. Byte layout matches the Pyth Solana receiver.
//
// Validator accounts are fixed when the network starts, so "fresh" prices are
// dated 30 minutes ahead: that keeps them after every order placed during the
// run, which the program requires. Only these test files do this.
const fs = require("fs");
const path = require("path");
const { PublicKey } = require("@solana/web3.js");

const RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
const PUSH_ORACLE = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
const DISCRIMINATOR = [34, 241, 35, 99, 157, 126, 244, 205];
const FEEDS = {
  AAPL_EQUITY: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  TSLA_EQUITY: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
  AAPLX: "978e6cc68a119ce066aa830017318563a9ed04ec3a0a6439010fc11296a58675",
  SLIGHTLY_STALE: "33".repeat(32),
  BEFORE_BOOK: "44".repeat(32),
};

// The canonical account Pyth keeps per feed (push oracle, shard 0).
const canonical = (feedHex) =>
  PublicKey.findProgramAddressSync([Buffer.from([0, 0]), Buffer.from(feedHex, "hex")], PUSH_ORACLE)[0].toBase58();

function priceUpdate(feedHex, publishTime) {
  const b = Buffer.alloc(133);
  let o = 0;
  Buffer.from(DISCRIMINATOR).copy(b, o); o += 8;
  o += 32; // write authority
  b.writeUInt8(1, o); o += 1; // VerificationLevel::Full
  Buffer.from(feedHex, "hex").copy(b, o); o += 32;
  b.writeBigInt64LE(1_000_000n, o); o += 8; // $10.00000
  b.writeBigUInt64LE(100n, o); o += 8; // conf
  b.writeInt32LE(-5, o); o += 4;
  b.writeBigInt64LE(BigInt(publishTime), o); o += 8;
  b.writeBigInt64LE(BigInt(publishTime - 1), o); o += 8;
  b.writeBigInt64LE(1_000_000n, o); o += 8; // ema price
  b.writeBigUInt64LE(100n, o); o += 8; // ema conf
  return b;
}

function write(file, pubkey, feedHex, publishTime) {
  const data = priceUpdate(feedHex, publishTime);
  const account = {
    pubkey,
    account: {
      lamports: 10_000_000,
      data: [data.toString("base64"), "base64"],
      owner: RECEIVER,
      executable: false,
      rentEpoch: 0,
      space: data.length,
    },
  };
  fs.writeFileSync(path.join(__dirname, "..", "tests", "fixtures", file), JSON.stringify(account, null, 2));
}

const now = Math.floor(Date.now() / 1000);
fs.mkdirSync(path.join(__dirname, "..", "tests", "fixtures"), { recursive: true });
write("aapl-equity-fresh.json", canonical(FEEDS.AAPL_EQUITY), FEEDS.AAPL_EQUITY, now + 1_800);
write("tsla-equity-closed.json", canonical(FEEDS.TSLA_EQUITY), FEEDS.TSLA_EQUITY, now - 86_400);
write("slightly-stale.json", canonical(FEEDS.SLIGHTLY_STALE), FEEDS.SLIGHTLY_STALE, now - 900);
write("before-book.json", canonical(FEEDS.BEFORE_BOOK), FEEDS.BEFORE_BOOK, now);
write("aaplx-fallback-fresh.json", "H1PFU9pRg879bM4TBUsr11igtAdt1xU7zHL673jg8hsJ", FEEDS.AAPLX, now + 1_800);
write("aaplx-fallback-early.json", "FDWVP2C1f7iYugmnYCdBE91Gw91wQsboiQ2ET2V9c5JQ", FEEDS.AAPLX, now);
console.log(`pyth fixtures written, now=${now}`);
