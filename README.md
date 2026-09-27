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

1. **Open a book.** `create_book` creates a `Book` account and Arcium writes an
   empty order book into it, encrypted to the MXE. The key is split across
   Arcium's nodes, so no single node can decrypt it.
2. **Submit orders.** The trader encrypts side, limit price and quantity on
   their own device and calls `submit_order`. Arcium adds the order to the
   encrypted book and writes it back.
3. **Clear.** `clear_batch` passes the book and a public price band to Arcium.
   The nodes compute the clearing price and each order's fill without
   decrypting anything, then reveal only the result.

### Clearing rules

- Candidate prices are the submitted limit prices that fall inside the band.
- The winner is the price that matches the most volume. Ties go to the lower
  price.
- Buys fill at or above their limit, sells at or below it, all at the one
  clearing price.
- The smaller side fills completely. The larger side is rationed in arrival
  order, so total bought always equals total sold.
- Quantities are in base-token units on both sides.

### What is revealed

| Revealed | Stays encrypted |
|----------|-----------------|
| Clearing price | Every limit price |
| Total matched volume | Size and side of unfilled orders |
| Fill for each order slot | The order book itself, before and after |

Token deposits and payouts are ordinary transfers and are visible on-chain.
What stays private is price and intent.

## Layout

| Path | What it is |
|------|------------|
| `encrypted-ixs/src/lib.rs` | Arcis circuits: `init_book`, `place_order`, `clear`, plus unit tests for the clearing logic |
| `programs/lattice_equities/src/lib.rs` | Anchor program that queues each circuit and stores results in callbacks |
| `tests/lattice_equities.ts` | End-to-end run of a 16-order batch, checked against a plain TypeScript implementation |
| `build/*.arcis` | Compiled circuits, fetched by Arcium nodes from this repo |

A book holds 16 orders. It is stored packed as 9 ciphertexts so each update fits
in one Solana transaction. One order is processed at a time, so every update
sees the latest book.

## Build and test

Requires Rust, Solana CLI, Anchor 1.0.2, Yarn, Docker and the Arcium CLI
(`arcup`).

```bash
yarn install
arcium build
arcium test
```

Unit tests for the clearing logic run as plain Rust, including a check that the
circuit matches a simple reference implementation on 20,000 random books:

```bash
cargo test -p encrypted-ixs clearing_tests
```

On Apple Silicon the circuit compiler can abort on a debug assertion. Disable
debug assertions for build scripts and macros:

```bash
export CARGO_PROFILE_DEV_BUILD_OVERRIDE_DEBUG_ASSERTIONS=false
export CARGO_PROFILE_TEST_BUILD_OVERRIDE_DEBUG_ASSERTIONS=false
```

## Verifying the circuits

The program pins each circuit by SHA-256 (`circuit_hash!`), and Arcium nodes
refuse a file that does not match. The build is deterministic, so to check that
the committed files are what the source compiles to, rebuild and confirm git
sees no change:

```bash
arcium build
git status --short build/
```
