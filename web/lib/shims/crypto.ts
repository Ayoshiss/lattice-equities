// Browser stand-in for the parts of Node's `crypto` that @arcium-hq/client
// imports. Only randomBytes and the hashes are reachable from the code paths
// the web app uses (x25519 + RescueCipher); the AES helpers are not.
import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha2.js";
import { sha3_256 } from "@noble/hashes/sha3.js";

export function randomBytes(n: number) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return Buffer.from(out);
}

export function createHash(algorithm: string) {
  const h = algorithm === "sha256" ? sha256.create() : algorithm === "sha3-256" ? sha3_256.create() : null;
  if (!h) throw new Error(`createHash(${algorithm}) is not available in the browser`);
  const api = {
    update(data: Uint8Array) { h.update(data); return api; },
    digest() { return Buffer.from(h.digest()); },
  };
  return api;
}

export function createCipheriv(): never { throw new Error("AES is not available in the browser"); }
export function createDecipheriv(): never { throw new Error("AES is not available in the browser"); }

export default { randomBytes, createHash, createCipheriv, createDecipheriv };
