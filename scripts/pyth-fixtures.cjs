// Writes Pyth PriceUpdateV2 accounts for the local test validator: one fresh,
// one a day old. Pyth does not run on localnet, so these stand in for real
// updates. Byte layout matches the Pyth Solana receiver.
const fs = require("fs");
const path = require("path");

const RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
const DISCRIMINATOR = [34, 241, 35, 99, 157, 126, 244, 205];
const AAPLX_USD = "978e6cc68a119ce066aa830017318563a9ed04ec3a0a6439010fc11296a58675";

function priceUpdate(publishTime) {
  const b = Buffer.alloc(133);
  let o = 0;
  Buffer.from(DISCRIMINATOR).copy(b, o); o += 8;
  o += 32; // write authority
  b.writeUInt8(1, o); o += 1; // VerificationLevel::Full
  Buffer.from(AAPLX_USD, "hex").copy(b, o); o += 32;
  b.writeBigInt64LE(1_000_000n, o); o += 8; // $10.00000
  b.writeBigUInt64LE(100n, o); o += 8; // conf
  b.writeInt32LE(-5, o); o += 4;
  b.writeBigInt64LE(BigInt(publishTime), o); o += 8;
  b.writeBigInt64LE(BigInt(publishTime - 1), o); o += 8;
  b.writeBigInt64LE(1_000_000n, o); o += 8; // ema price
  b.writeBigUInt64LE(100n, o); o += 8; // ema conf
  return b;
}

function write(file, pubkey, publishTime) {
  const data = priceUpdate(publishTime);
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
write("pyth-fresh.json", "H1PFU9pRg879bM4TBUsr11igtAdt1xU7zHL673jg8hsJ", now);
write("pyth-stale.json", "FDWVP2C1f7iYugmnYCdBE91Gw91wQsboiQ2ET2V9c5JQ", now - 86_400);
console.log(`pyth fixtures written, publish_time=${now}`);
