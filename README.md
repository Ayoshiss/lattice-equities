# Lattice Equities

Sealed batch auctions for tokenized stocks on Solana. Orders stay encrypted the
whole time, and the batch clears at one price inside a band around the reference
price. Matching runs on [Arcium](https://arcium.com), so no single node, and not
us, ever sees an order.

## Why

Tokenized stocks on Solana mostly trade in public AMM pools, where every order
is readable before it fills. That invites front-running, it breaks down after
hours and on weekends when the real market is closed, and it leaks the strategy
of anyone trading size. Traditional exchanges already solve this at the open and
close with a call auction. This brings that auction on-chain, with the orders
encrypted.

## How it works

1. **Open a book.** `create_book` creates a `Book` for a base token (the stock)
   and a quote token, with a lot size, a Pyth price feed, a maximum price age
   and a band width. Arcium writes an empty order book into
   it, encrypted to the MXE. The key is split across Arcium's nodes, so no
   single node can decrypt it. `open_vaults` creates the book's token vaults.
2. **Submit orders.** The trader encrypts side, limit price and quantity on
   their own device and calls `submit_order` with a deposit: quote tokens for a
   buy, whole lots of base for a sell. The deposit goes to the vault and an
   `OrderTicket` account records it. Arcium checks inside the computation that
   the deposit covers the order, then adds it to the encrypted book.
3. **Clear.** `clear_batch` reads the book's Pyth price and sets the band from
   it, then passes the book and band to Arcium. The nodes compute the clearing
   price and each order's fill without decrypting anything, then reveal only
   the result.
4. **Settle.** `settle_order` pays out one ticket and closes it. A buyer gets
   base lots plus any unspent quote; a seller gets quote plus any unsold base.
   Anyone can call it, but tokens only go to the ticket's trader.

If an encrypted computation fails, the book is not left locked: a failed order
marks its ticket refundable (`refund_failed_order`), and a failed clear reopens
the book so it can be cleared again.

### Clearing rules

- Candidate prices are the submitted limit prices that fall inside the band.
- The winner is the price that matches the most volume. Ties go to the lower
  price.
- Buys fill at or above their limit, sells at or below it, all at the one
  clearing price.
- The smaller side fills completely. The larger side is rationed in arrival
  order, so total bought always equals total sold.
- Quantities are in lots and prices in quote units per lot, so all math is in
  whole numbers.
- An order whose deposit does not cover it (quantity times limit for a buy,
  quantity in lots for a sell) is kept at zero quantity inside the computation.
  It never fills and is refunded in full, and nothing about it is revealed.

### Reference price

The band comes from a [Pyth](https://pyth.network) price update, and the batch
does not clear unless the update:

- is a fully verified Pyth account (owner and account type are checked)
- is for the feed the book was created with
- is no older than the book's maximum age
- has a confidence interval narrower than the band

The price is converted to quote units per lot and widened by the band width.
The band used is stored on the book and emitted with the result. For stocks
that trade around the clock, such as xStocks, use the token's 24/7 feed (for
example `Crypto.AAPLX/USD`) rather than the exchange feed, which goes stale
outside market hours.

### What is revealed

| Revealed | Stays encrypted |
|----------|-----------------|
| Clearing price | Every limit price |
| Total matched volume | Size and side of unfilled orders |
| Fill for each order slot | The order book itself, before and after |

Deposits and payouts are ordinary token transfers and are visible on-chain,
so the side of an order and an upper bound on its size are public. What stays
private is the limit price, the exact size, and everything about orders that
do not fill.

## Layout

| Path | What it is |
|------|------------|
| `encrypted-ixs/src/lib.rs` | Arcis circuits: `init_book`, `place_order`, `clear`, plus unit tests for the clearing logic |
| `programs/lattice_equities/src/lib.rs` | Anchor program that queues each circuit and stores results in callbacks |
| `tests/lattice_equities.ts` | End-to-end batch with real token deposits and settlement, checked against a plain TypeScript implementation |
| `circuits/` | Published circuits, named `<circuit>-<first 8 hex of SHA-256>.arcis`. Arcium nodes fetch them from here |
| `scripts/publish-circuits.sh` | Copies fresh builds into `circuits/`. Existing files are never overwritten |
| `scripts/pyth-fixtures.cjs` | Writes stand-in Pyth price accounts (fresh and stale) for the local test network |

A book holds 16 orders. It is stored packed as 9 ciphertexts so each update fits
in one Solana transaction. One order is processed at a time, so every update
sees the latest book.

Circuit files are content-addressed and never replaced, so a deployed program
always finds the exact circuit it was registered with, even after new ones are
published.

## Build and test

Requires Rust, Solana CLI, Anchor 1.0.2, Yarn, Docker and the Arcium CLI
(`arcup`).

```bash
yarn install
arcium build
```

Deployed builds fetch circuits from `circuits/` on GitHub. For local tests,
build the program with `local-circuits` so the local network uses the circuits
from your own build instead:

Pyth does not run locally, so generate stand-in price accounts first. They
are loaded through `Anchor.toml`.

```bash
arcium build --skip-program
anchor build -- --features local-circuits
node scripts/pyth-fixtures.cjs
arcium test --skip-build
```

Rebuild without the feature before deploying.

Unit tests run as plain Rust: the clearing logic, including a check against a
simple reference implementation on 20,000 random books, and the Pyth price
parsing and conversion:

```bash
cargo test -p encrypted-ixs clearing_tests
cargo test -p lattice_equities price_tests
```

On Apple Silicon the circuit compiler can abort on a debug assertion. Disable
debug assertions for build scripts and macros:

```bash
export CARGO_PROFILE_DEV_BUILD_OVERRIDE_DEBUG_ASSERTIONS=false
export CARGO_PROFILE_TEST_BUILD_OVERRIDE_DEBUG_ASSERTIONS=false
```

## Verifying the circuits

The program pins each circuit by SHA-256 (`circuit_hash!`), and Arcium nodes
refuse a file that does not match. The build is deterministic, so anyone can
rebuild and confirm the output matches the published file:

```bash
arcium build
shasum -a 256 build/*.arcis
ls circuits/
```

Each file in `circuits/` is named after the first 8 hex characters of its hash,
so the two lists should line up.
