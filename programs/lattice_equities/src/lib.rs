//! Lattice Equities: encrypted uniform-price batch auction.
//!
//! The order book lives encrypted in the `Book` PDA (a packed `Book` owned by the
//! MXE). Orders are folded in one at a time by `place_order`; `clear` computes the
//! clearing price inside MPC and reveals only the price, matched volume and
//! per-slot fills. Limit prices and unfilled quantities are never revealed.
//!
//! `Book` layout: the encrypted book starts at offset 60 =
//! 8 (discriminator) + 1 (bump) + 32 (authority) + 1 (order_count) + 1 (status)
//! + 1 (pending) + 16 (state_nonce), followed by BOOK_CIPHERTEXTS x 32 bytes.

use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::{CallbackAccount, CircuitSource, OffChainCircuitSource};
use arcium_macros::circuit_hash;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

const COMP_DEF_OFFSET_INIT_BOOK: u32 = comp_def_offset("init_book");
const COMP_DEF_OFFSET_PLACE_ORDER: u32 = comp_def_offset("place_order_v2");
const COMP_DEF_OFFSET_CLEAR: u32 = comp_def_offset("clear_v2");

pub const MAX_ORDERS: u8 = 16;
const BOOK_CIPHERTEXTS: usize = 9;
const ENCRYPTED_BOOK_OFFSET: u32 = 60;
const ENCRYPTED_BOOK_SIZE: u32 = 32 * BOOK_CIPHERTEXTS as u32;

pub const STATUS_OPEN: u8 = 0;
pub const STATUS_CLEARING: u8 = 1;
pub const STATUS_CLEARED: u8 = 2;
pub const STATUS_DEAD: u8 = 3;

// What the book is waiting on while `pending` is set.
pub const PENDING_INIT: u8 = 1;
pub const PENDING_ORDER: u8 = 2;
pub const PENDING_CLEAR: u8 = 3;

// Pyth pull-oracle price accounts (PriceUpdateV2), owned by the Pyth receiver.
const PYTH_RECEIVER: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
// Canonical per-feed price accounts are PDAs of the Pyth push oracle (shard 0).
// Anyone can refresh them with a newer verified update, so their staleness is a fact.
const PYTH_PUSH_ORACLE: Pubkey = pubkey!("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];
const BPS: u64 = 10_000;

pub const TICKET_PENDING: u8 = 0;
pub const TICKET_LIVE: u8 = 1;
pub const TICKET_FAILED: u8 = 2;

// Circuits are too large to store on-chain cheaply, so Arx nodes fetch them from
// the public repo and verify them against the SHA-256 embedded at build time.
// Local tests build with `local-circuits`, where arcium pre-seeds them on-chain.
// A build can point at another branch (e.g. for a devnet experiment) by setting
// LATTICE_CIRCUIT_BASE_URL at compile time; the hash pin applies either way.
const CIRCUIT_BASE_URL: &str = match option_env!("LATTICE_CIRCUIT_BASE_URL") {
    Some(url) => url,
    None => "https://raw.githubusercontent.com/Ayoshiss/lattice-equities/main/circuits/",
};

fn circuit_source(name: &str, hash: [u8; 32]) -> Option<CircuitSource> {
    if cfg!(feature = "local-circuits") {
        return None;
    }
    // Published as <name>-<first 8 hex of hash>.arcis and never overwritten, so
    // every deployed version keeps fetching exactly the circuit it was built with.
    let tag = format!("{:02x}{:02x}{:02x}{:02x}", hash[0], hash[1], hash[2], hash[3]);
    Some(CircuitSource::OffChain(OffChainCircuitSource {
        source: format!("{CIRCUIT_BASE_URL}{name}-{tag}.arcis"),
        hash,
    }))
}

declare_id!("AUXkwEowRX7BMPXGF1Ak2nC9Ni5SML7EU6fB6Jo1zvgm");

#[arcium_program]
pub mod lattice_equities {
    use super::*;

    pub fn init_init_book_comp_def(ctx: Context<InitInitBookCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, circuit_source("init_book", circuit_hash!("init_book")))?;
        Ok(())
    }

    pub fn init_place_order_v2_comp_def(ctx: Context<InitPlaceOrderV2CompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, circuit_source("place_order_v2", circuit_hash!("place_order_v2")))?;
        Ok(())
    }

    pub fn init_clear_v2_comp_def(ctx: Context<InitClearV2CompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, circuit_source("clear_v2", circuit_hash!("clear_v2")))?;
        Ok(())
    }

    pub fn create_book(
        ctx: Context<CreateBook>,
        computation_offset: u64,
        book_id: u64,
        lot_size: u64,
        price_feed_id: [u8; 32],
        max_price_age_secs: u32,
        band_bps: u16,
        pending_timeout_secs: u32,
        fallback_feed_id: [u8; 32],
        fallback_band_bps: u16,
        market_closed_after_secs: u32,
    ) -> Result<()> {
        require!(lot_size > 0, ErrorCode::InvalidLotSize);
        require!(pending_timeout_secs > 0, ErrorCode::InvalidTimeout);
        require!(band_bps > 0 && (band_bps as u64) < BPS, ErrorCode::InvalidBand);
        require!(max_price_age_secs > 0, ErrorCode::InvalidBand);
        if fallback_feed_id != [0u8; 32] {
            require!(
                fallback_band_bps >= band_bps && (fallback_band_bps as u64) < BPS,
                ErrorCode::InvalidFallback
            );
            require!(market_closed_after_secs > max_price_age_secs, ErrorCode::InvalidFallback);
        }
        let book = &mut ctx.accounts.book;
        book.bump = ctx.bumps.book;
        book.authority = ctx.accounts.authority.key();
        book.book_id = book_id;
        book.base_mint = ctx.accounts.base_mint.key();
        book.quote_mint = ctx.accounts.quote_mint.key();
        book.lot_size = lot_size;
        book.base_decimals = ctx.accounts.base_mint.decimals;
        book.quote_decimals = ctx.accounts.quote_mint.decimals;
        book.price_feed_id = price_feed_id;
        book.max_price_age_secs = max_price_age_secs;
        book.band_bps = band_bps;
        book.primary_price_account = canonical_price_account(&price_feed_id);
        book.fallback_feed_id = fallback_feed_id;
        book.fallback_band_bps = fallback_band_bps;
        book.market_closed_after_secs = market_closed_after_secs;
        book.last_order_at = Clock::get()?.unix_timestamp;
        book.pending_timeout_secs = pending_timeout_secs;
        book.order_count = 0;
        book.status = STATUS_OPEN;
        book.encrypted_book = [[0u8; 32]; BOOK_CIPHERTEXTS];
        start_pending(book, PENDING_INIT, ctx.accounts.computation_account.key(), Pubkey::default())?;

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            ArgBuilder::new().build(),
            vec![InitBookCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount { pubkey: ctx.accounts.book.key(), is_writable: true }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    pub fn open_vaults(ctx: Context<OpenVaults>) -> Result<()> {
        let book = &mut ctx.accounts.book;
        book.base_vault = ctx.accounts.base_vault.key();
        book.quote_vault = ctx.accounts.quote_vault.key();
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "init_book")]
    pub fn init_book_callback(
        ctx: Context<InitBookCallback>,
        output: SignedComputationOutputs<InitBookOutput>,
    ) -> Result<()> {
        let book = &mut ctx.accounts.book;
        if !is_current(book, &ctx.accounts.computation_account.key()) {
            return Ok(());
        }
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(InitBookOutput { field_0 }) => field_0,
            Err(_) => {
                book.status = STATUS_DEAD;
                end_pending(book);
                return Ok(());
            }
        };
        book.encrypted_book = o.ciphertexts;
        book.state_nonce = o.nonce;
        end_pending(book);
        emit!(BookReadyEvent { book: book.key() });
        Ok(())
    }

    /// Queues `place_order` with the trader's encrypted order and the current book.
    /// Only one order is in flight at a time, so each computation sees the latest book.
    pub fn submit_order(
        ctx: Context<SubmitOrder>,
        computation_offset: u64,
        encrypted_side: [u8; 32],
        encrypted_price: [u8; 32],
        encrypted_qty: [u8; 32],
        trader_pubkey: [u8; 32],
        nonce: u128,
        base_deposit: u64,
        quote_deposit: u64,
    ) -> Result<()> {
        let book = &mut ctx.accounts.book;
        require!(book.status == STATUS_OPEN, ErrorCode::BookNotOpen);
        require!(!book.pending, ErrorCode::ComputationPending);
        require!(book.order_count < MAX_ORDERS, ErrorCode::BookFull);
        require!(book.base_vault != Pubkey::default(), ErrorCode::VaultsNotOpen);
        // Exactly one side is funded: quote for a buy, whole lots of base for a sell.
        require!((base_deposit == 0) != (quote_deposit == 0), ErrorCode::BadDeposit);
        require!(base_deposit % book.lot_size == 0, ErrorCode::BadDeposit);
        let (deposit, vault) = if quote_deposit > 0 {
            (quote_deposit, book.quote_vault)
        } else {
            (base_deposit, book.base_vault)
        };
        require_keys_eq!(ctx.accounts.vault.key(), vault, ErrorCode::WrongVault);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.trader_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.trader.to_account_info(),
                },
            ),
            deposit,
        )?;
        let ticket = &mut ctx.accounts.ticket;
        ticket.book = book.key();
        ticket.trader = ctx.accounts.trader.key();
        ticket.slot = book.order_count;
        ticket.status = TICKET_PENDING;
        ticket.base_deposit = base_deposit;
        ticket.quote_deposit = quote_deposit;
        book.next_ticket = book.next_ticket.checked_add(1).ok_or(ErrorCode::Overflow)?;
        let base_lots = base_deposit / book.lot_size;
        start_pending(book, PENDING_ORDER, ctx.accounts.computation_account.key(), ctx.accounts.ticket.key())?;

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Order matches the circuit: Enc<Shared, Order> then Enc<Mxe, Pack<Book>>.
        let args = ArgBuilder::new()
            .x25519_pubkey(trader_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u8(encrypted_side)
            .encrypted_u32(encrypted_price)
            .encrypted_u64(encrypted_qty)
            .plaintext_u128(book.state_nonce)
            .account(book.key(), ENCRYPTED_BOOK_OFFSET, ENCRYPTED_BOOK_SIZE)
            .plaintext_u64(base_lots)
            .plaintext_u64(quote_deposit)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![PlaceOrderV2Callback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount { pubkey: ctx.accounts.book.key(), is_writable: true },
                    CallbackAccount { pubkey: ctx.accounts.ticket.key(), is_writable: true },
                ],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "place_order_v2")]
    pub fn place_order_v2_callback(
        ctx: Context<PlaceOrderV2Callback>,
        output: SignedComputationOutputs<PlaceOrderV2Output>,
    ) -> Result<()> {
        let book = &mut ctx.accounts.book;
        let ticket = &mut ctx.accounts.ticket;
        // A result for a computation the book already gave up on (expire_pending)
        // must not touch the book: a newer order may be in flight.
        if !is_current(book, &ctx.accounts.computation_account.key()) {
            return Ok(());
        }
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(PlaceOrderV2Output { field_0 }) => field_0,
            Err(_) => {
                // The order never reached the encrypted book. Unlock the book and let
                // the trader take the deposit back with refund_failed_order.
                ticket.status = TICKET_FAILED;
                end_pending(book);
                emit!(OrderFailedEvent { book: book.key(), trader: ticket.trader });
                return Ok(());
            }
        };
        ticket.status = TICKET_LIVE;
        book.encrypted_book = o.ciphertexts;
        book.state_nonce = o.nonce;
        book.order_count += 1;
        book.last_order_at = Clock::get()?.unix_timestamp;
        end_pending(book);
        emit!(OrderPlacedEvent { book: book.key(), order_count: book.order_count });
        Ok(())
    }

    /// Queues `clear` with the Pyth-derived band. The band is public; the book is not.
    pub fn clear_batch(ctx: Context<ClearBatch>, computation_offset: u64) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.price_update.key(),
            ctx.accounts.book.primary_price_account,
            ErrorCode::WrongPriceAccount
        );
        let primary = read_pyth_account(&ctx.accounts.price_update)?;
        let fallback = match &ctx.accounts.fallback_update {
            Some(acc) => Some(read_pyth_account(acc)?),
            None => None,
        };
        let book = &mut ctx.accounts.book;
        require!(book.status == STATUS_OPEN, ErrorCode::BookNotOpen);
        require!(!book.pending, ErrorCode::ComputationPending);
        let rules = PriceRules {
            primary_feed: book.price_feed_id,
            fallback_feed: book.fallback_feed_id,
            max_age: book.max_price_age_secs as i64,
            closed_after: book.market_closed_after_secs as i64,
            cutoff: book.last_order_at,
            band_bps: book.band_bps,
            fallback_band_bps: book.fallback_band_bps,
        };
        let (quote, band_bps, used_fallback) =
            select_reference(Clock::get()?.unix_timestamp, &rules, &primary, fallback.as_ref())?;
        let (band_lo, band_hi) = price_band(quote, book.lot_size, book.base_decimals, book.quote_decimals, band_bps)?;
        book.band_lo = band_lo;
        book.band_hi = band_hi;
        book.used_fallback = used_fallback;
        book.status = STATUS_CLEARING;
        start_pending(book, PENDING_CLEAR, ctx.accounts.computation_account.key(), Pubkey::default())?;

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let args = ArgBuilder::new()
            .plaintext_u128(book.state_nonce)
            .account(book.key(), ENCRYPTED_BOOK_OFFSET, ENCRYPTED_BOOK_SIZE)
            .plaintext_u32(band_lo)
            .plaintext_u32(band_hi)
            .plaintext_u32(book.cancelled_mask)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ClearV2Callback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount { pubkey: ctx.accounts.book.key(), is_writable: true }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "clear_v2")]
    pub fn clear_v2_callback(
        ctx: Context<ClearV2Callback>,
        output: SignedComputationOutputs<ClearV2Output>,
    ) -> Result<()> {
        let book = &mut ctx.accounts.book;
        if !is_current(book, &ctx.accounts.computation_account.key()) {
            return Ok(());
        }
        let r = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(ClearV2Output { field_0 }) => field_0,
            Err(_) => {
                // Reopen so the authority can retry the clear.
                book.status = STATUS_OPEN;
                end_pending(book);
                emit!(ClearFailedEvent { book: book.key() });
                return Ok(());
            }
        };
        book.clearing_price = r.field_0;
        book.matched = r.field_1;
        book.fills = r.field_2;
        book.status = STATUS_CLEARED;
        end_pending(book);
        emit!(BatchClearedEvent {
            book: book.key(),
            band_lo: book.band_lo,
            band_hi: book.band_hi,
            used_fallback: book.used_fallback,
            clearing_price: book.clearing_price,
            matched: book.matched,
            fills: book.fills,
        });
        Ok(())
    }

    /// Returns the deposit of an order whose encrypted computation failed, and
    /// closes its ticket back to the trader.
    pub fn refund_failed_order(ctx: Context<RefundFailedOrder>) -> Result<()> {
        let book = &ctx.accounts.book;
        let ticket = &ctx.accounts.ticket;
        require!(ticket.status == TICKET_FAILED, ErrorCode::NothingToSettle);
        require_keys_eq!(ctx.accounts.trader_token.owner, ticket.trader, ErrorCode::WrongTrader);
        let (amount, vault, mint) = if ticket.quote_deposit > 0 {
            (ticket.quote_deposit, book.quote_vault, book.quote_mint)
        } else {
            (ticket.base_deposit, book.base_vault, book.base_mint)
        };
        require_keys_eq!(ctx.accounts.vault.key(), vault, ErrorCode::WrongVault);
        require_keys_eq!(ctx.accounts.trader_token.mint, mint, ErrorCode::WrongTrader);
        pay_from_vault(
            book,
            ctx.accounts.book.to_account_info(),
            ctx.accounts.token_program.key(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.trader_token.to_account_info(),
            amount,
        )
    }

    /// Releases a book stuck waiting on a computation that never returned. Anyone
    /// can call it once the book's timeout has passed: a stuck order becomes
    /// refundable, a stuck clear reopens the book, a stuck setup marks it dead.
    pub fn expire_pending(ctx: Context<ExpirePending>) -> Result<()> {
        let book = &mut ctx.accounts.book;
        require!(book.pending, ErrorCode::NothingPending);
        let now = Clock::get()?.unix_timestamp;
        require!(
            now.saturating_sub(book.pending_since) >= book.pending_timeout_secs as i64,
            ErrorCode::TimeoutNotReached
        );
        match book.pending_kind {
            PENDING_ORDER => {
                let ticket = ctx.accounts.ticket.as_mut().ok_or(ErrorCode::WrongTicket)?;
                require_keys_eq!(ticket.key(), book.pending_ticket, ErrorCode::WrongTicket);
                ticket.status = TICKET_FAILED;
            }
            PENDING_CLEAR => book.status = STATUS_OPEN,
            _ => book.status = STATUS_DEAD,
        }
        emit!(PendingExpiredEvent { book: book.key(), kind: book.pending_kind });
        end_pending(book);
        Ok(())
    }

    /// Pulls a live order out before the clear and refunds its deposit. The order
    /// stays in the encrypted book, but its slot is marked cancelled, and the clear
    /// treats cancelled slots as size zero, so it can never fill.
    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        let book = &ctx.accounts.book;
        let ticket = &ctx.accounts.ticket;
        require!(book.status == STATUS_OPEN, ErrorCode::BookNotOpen);
        require!(ticket.status == TICKET_LIVE, ErrorCode::NothingToSettle);
        require_keys_eq!(ctx.accounts.trader_token.owner, ticket.trader, ErrorCode::WrongTrader);
        let (amount, vault, mint) = if ticket.quote_deposit > 0 {
            (ticket.quote_deposit, book.quote_vault, book.quote_mint)
        } else {
            (ticket.base_deposit, book.base_vault, book.base_mint)
        };
        require_keys_eq!(ctx.accounts.vault.key(), vault, ErrorCode::WrongVault);
        require_keys_eq!(ctx.accounts.trader_token.mint, mint, ErrorCode::WrongTrader);
        pay_from_vault(
            book,
            ctx.accounts.book.to_account_info(),
            ctx.accounts.token_program.key(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.trader_token.to_account_info(),
            amount,
        )?;
        let slot = ticket.slot;
        let book = &mut ctx.accounts.book;
        book.cancelled_mask |= 1u32 << slot;
        emit!(OrderCancelledEvent { book: book.key(), slot, trader: ctx.accounts.trader.key() });
        Ok(())
    }

    /// Pays out one order after the clear and closes its ticket. Anyone can call it,
    /// but funds only go to the ticket's trader. A buyer gets base lots plus unspent
    /// quote back; a seller gets quote plus unsold base back. No cross: full refund.
    pub fn settle_order(ctx: Context<SettleOrder>) -> Result<()> {
        let book = &ctx.accounts.book;
        let order = &ctx.accounts.ticket;
        require!(book.status == STATUS_CLEARED, ErrorCode::NotCleared);
        require!(order.status == TICKET_LIVE, ErrorCode::NothingToSettle);
        require_keys_eq!(ctx.accounts.trader_base.owner, order.trader, ErrorCode::WrongTrader);
        require_keys_eq!(ctx.accounts.trader_quote.owner, order.trader, ErrorCode::WrongTrader);

        let slot = order.slot;
        let trader = order.trader;
        let fill = book.fills[slot as usize];
        let quote_traded = fill.checked_mul(book.clearing_price as u64).ok_or(ErrorCode::Overflow)?;
        let base_traded = fill.checked_mul(book.lot_size).ok_or(ErrorCode::Overflow)?;
        let (base_out, quote_out) = if order.quote_deposit > 0 {
            (base_traded, order.quote_deposit.checked_sub(quote_traded).ok_or(ErrorCode::Overflow)?)
        } else {
            (order.base_deposit.checked_sub(base_traded).ok_or(ErrorCode::Overflow)?, quote_traded)
        };

        let authority = book.authority;
        let book_id = book.book_id.to_le_bytes();
        let bump = [book.bump];
        let seeds: &[&[u8]] = &[b"book", authority.as_ref(), &book_id, &bump];
        let signer = &[seeds];
        let book_info = ctx.accounts.book.to_account_info();
        let token_program = ctx.accounts.token_program.key();

        if base_out > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    token_program,
                    Transfer {
                        from: ctx.accounts.base_vault.to_account_info(),
                        to: ctx.accounts.trader_base.to_account_info(),
                        authority: book_info.clone(),
                    },
                    signer,
                ),
                base_out,
            )?;
        }
        if quote_out > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    token_program,
                    Transfer {
                        from: ctx.accounts.quote_vault.to_account_info(),
                        to: ctx.accounts.trader_quote.to_account_info(),
                        authority: book_info,
                    },
                    signer,
                ),
                quote_out,
            )?;
        }

        emit!(OrderSettledEvent { book: book.key(), slot, trader, base_out, quote_out });
        Ok(())
    }
}

fn start_pending(book: &mut Book, kind: u8, computation: Pubkey, ticket: Pubkey) -> Result<()> {
    book.pending = true;
    book.pending_kind = kind;
    book.pending_since = Clock::get()?.unix_timestamp;
    book.pending_computation = computation;
    book.pending_ticket = ticket;
    Ok(())
}

fn end_pending(book: &mut Book) {
    book.pending = false;
    book.pending_kind = 0;
    book.pending_computation = Pubkey::default();
    book.pending_ticket = Pubkey::default();
}

fn is_current(book: &Book, computation: &Pubkey) -> bool {
    book.pending && book.pending_computation == *computation
}

fn pay_from_vault<'info>(
    book: &Book,
    book_info: AccountInfo<'info>,
    token_program: Pubkey,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let book_id = book.book_id.to_le_bytes();
    let bump = [book.bump];
    let seeds: &[&[u8]] = &[b"book", book.authority.as_ref(), &book_id, &bump];
    token::transfer(
        CpiContext::new_with_signer(token_program, Transfer { from, to, authority: book_info }, &[seeds]),
        amount,
    )
}

pub struct PythPrice {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
}

/// Reads a Pyth PriceUpdateV2 account. Only fully verified updates are accepted.
/// Layout: discriminator(8) write_authority(32) verification_level(1, Full)
/// feed_id(32) price(i64) conf(u64) exponent(i32) publish_time(i64) ...
pub fn read_price_update(data: &[u8]) -> Result<PythPrice> {
    require!(data.len() >= 101, ErrorCode::BadPriceAccount);
    require!(data[..8] == PRICE_UPDATE_V2_DISCRIMINATOR, ErrorCode::BadPriceAccount);
    // Borsh enum tag: 0 = Partial { num_signatures }, 1 = Full.
    require!(data[40] == 1, ErrorCode::PriceNotFullyVerified);
    let le8 = |at: usize| <[u8; 8]>::try_from(&data[at..at + 8]).unwrap();
    Ok(PythPrice {
        feed_id: data[41..73].try_into().unwrap(),
        price: i64::from_le_bytes(le8(73)),
        conf: u64::from_le_bytes(le8(81)),
        exponent: i32::from_le_bytes(data[89..93].try_into().unwrap()),
        publish_time: i64::from_le_bytes(le8(93)),
    })
}

/// Converts the Pyth price to quote atoms per lot and widens it by band_bps.
/// Rejects the price when Pyth's own confidence interval is wider than the band.
pub fn price_band(
    p: &PythPrice,
    lot_size: u64,
    base_decimals: u8,
    quote_decimals: u8,
    band_bps: u16,
) -> Result<(u32, u32)> {
    require!(p.price > 0, ErrorCode::BadPriceAccount);
    let price = p.price as u128;
    require!(
        (p.conf as u128) * (BPS as u128) <= price * band_bps as u128,
        ErrorCode::PriceTooUncertain
    );
    // quote atoms per lot = price * 10^exponent * lot_size / 10^base_dec * 10^quote_dec
    let scale = quote_decimals as i32 + p.exponent - base_decimals as i32;
    require!(scale.abs() <= 30, ErrorCode::PriceOutOfRange);
    let mut per_lot = price.checked_mul(lot_size as u128).ok_or(ErrorCode::PriceOutOfRange)?;
    let pow = 10u128.pow(scale.unsigned_abs());
    per_lot = if scale >= 0 {
        per_lot.checked_mul(pow).ok_or(ErrorCode::PriceOutOfRange)?
    } else {
        per_lot / pow
    };
    let lo = per_lot * (BPS - band_bps as u64) as u128 / BPS as u128;
    let hi = (per_lot * (BPS + band_bps as u64) as u128).div_ceil(BPS as u128);
    require!(lo > 0 && hi <= u32::MAX as u128, ErrorCode::PriceOutOfRange);
    Ok((lo as u32, hi as u32))
}

pub fn canonical_price_account(feed_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[&0u16.to_le_bytes(), feed_id], &PYTH_PUSH_ORACLE).0
}

fn read_pyth_account(acc: &AccountInfo) -> Result<PythPrice> {
    require_keys_eq!(*acc.owner, PYTH_RECEIVER, ErrorCode::BadPriceAccount);
    read_price_update(&acc.try_borrow_data()?)
}

pub struct PriceRules {
    pub primary_feed: [u8; 32],
    pub fallback_feed: [u8; 32],
    pub max_age: i64,
    pub closed_after: i64,
    pub cutoff: i64,
    pub band_bps: u16,
    pub fallback_band_bps: u16,
}

/// Picks the reference price for a clear. The exchange (primary) price is used
/// whenever it is fresh. The 24/7 fallback is only allowed once the primary has
/// been silent past `closed_after`, i.e. the exchange is closed. Either way the
/// price must be published after the last order entered the book, so the book
/// owner cannot hold back an older, friendlier update.
pub fn select_reference<'a>(
    now: i64,
    r: &PriceRules,
    primary: &'a PythPrice,
    fallback: Option<&'a PythPrice>,
) -> Result<(&'a PythPrice, u16, bool)> {
    require!(primary.feed_id == r.primary_feed, ErrorCode::WrongPriceFeed);
    let age = now.saturating_sub(primary.publish_time);
    if age <= r.max_age {
        require!(primary.publish_time >= r.cutoff, ErrorCode::PriceBeforeCutoff);
        return Ok((primary, r.band_bps, false));
    }
    require!(r.fallback_feed != [0u8; 32] && age >= r.closed_after, ErrorCode::StalePrice);
    let fb = fallback.ok_or(ErrorCode::MissingFallbackPrice)?;
    require!(fb.feed_id == r.fallback_feed, ErrorCode::WrongPriceFeed);
    require!(now.saturating_sub(fb.publish_time) <= r.max_age, ErrorCode::StalePrice);
    require!(fb.publish_time >= r.cutoff, ErrorCode::PriceBeforeCutoff);
    Ok((fb, r.fallback_band_bps, true))
}

/// One per order. Holds the public side of the order (who, and what they
/// deposited) and which encrypted-book slot it landed in.
#[account]
#[derive(InitSpace)]
pub struct OrderTicket {
    pub book: Pubkey,
    pub trader: Pubkey,
    pub slot: u8,
    pub status: u8,
    pub base_deposit: u64,
    pub quote_deposit: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Book {
    pub bump: u8,
    pub authority: Pubkey,
    pub order_count: u8,
    pub status: u8,
    pub pending: bool,
    pub state_nonce: u128,
    pub encrypted_book: [[u8; 32]; BOOK_CIPHERTEXTS],
    pub clearing_price: u32,
    pub matched: u64,
    pub fills: [u64; MAX_ORDERS as usize],
    pub book_id: u64,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub lot_size: u64,
    pub next_ticket: u32,
    pub base_decimals: u8,
    pub quote_decimals: u8,
    pub price_feed_id: [u8; 32],
    pub max_price_age_secs: u32,
    pub band_bps: u16,
    pub band_lo: u32,
    pub band_hi: u32,
    pub pending_kind: u8,
    pub pending_since: i64,
    pub pending_computation: Pubkey,
    pub pending_ticket: Pubkey,
    pub pending_timeout_secs: u32,
    pub cancelled_mask: u32,
    pub primary_price_account: Pubkey,
    pub fallback_feed_id: [u8; 32],
    pub fallback_band_bps: u16,
    pub market_closed_after_secs: u32,
    pub last_order_at: i64,
    pub used_fallback: bool,
}

#[derive(Accounts)]
pub struct OpenVaults<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ ErrorCode::Unauthorized, has_one = base_mint, has_one = quote_mint)]
    pub book: Box<Account<'info, Book>>,
    pub base_mint: Box<Account<'info, Mint>>,
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = authority,
        seeds = [b"vault", book.key().as_ref(), base_mint.key().as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = book,
    )]
    pub base_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = authority,
        seeds = [b"vault", book.key().as_ref(), quote_mint.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = book,
    )]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExpirePending<'info> {
    pub caller: Signer<'info>,
    #[account(mut)]
    pub book: Box<Account<'info, Book>>,
    /// The pending order's ticket, required when the book is waiting on an order.
    #[account(mut, has_one = book)]
    pub ticket: Option<Box<Account<'info, OrderTicket>>>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(mut)]
    pub book: Box<Account<'info, Book>>,
    #[account(mut, has_one = book, has_one = trader, close = trader)]
    pub ticket: Box<Account<'info, OrderTicket>>,
    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub trader_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RefundFailedOrder<'info> {
    pub book: Box<Account<'info, Book>>,
    #[account(mut, has_one = book, has_one = trader, close = trader)]
    pub ticket: Box<Account<'info, OrderTicket>>,
    /// CHECK: receives the ticket rent; must be the ticket's trader.
    #[account(mut)]
    pub trader: UncheckedAccount<'info>,
    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub trader_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettleOrder<'info> {
    pub book: Box<Account<'info, Book>>,
    #[account(mut, has_one = book, has_one = trader, close = trader)]
    pub ticket: Box<Account<'info, OrderTicket>>,
    /// CHECK: receives the ticket rent; must be the ticket's trader.
    #[account(mut)]
    pub trader: UncheckedAccount<'info>,
    #[account(mut, address = book.base_vault @ ErrorCode::WrongVault)]
    pub base_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = book.quote_vault @ ErrorCode::WrongVault)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = book.base_mint)]
    pub trader_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = book.quote_mint)]
    pub trader_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[queue_computation_accounts("init_book", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, book_id: u64)]
pub struct CreateBook<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub base_mint: Box<Account<'info, Mint>>,
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = authority,
        space = 8 + Book::INIT_SPACE,
        seeds = [b"book", authority.key().as_ref(), &book_id.to_le_bytes()],
        bump,
    )]
    pub book: Box<Account<'info, Book>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_BOOK))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("init_book")]
#[derive(Accounts)]
pub struct InitBookCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_BOOK))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub book: Box<Account<'info, Book>>,
}

#[queue_computation_accounts("place_order_v2", trader)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct SubmitOrder<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(mut)]
    pub book: Box<Account<'info, Book>>,
    #[account(
        init,
        payer = trader,
        space = 8 + OrderTicket::INIT_SPACE,
        seeds = [b"ticket", book.key().as_ref(), &book.next_ticket.to_le_bytes()],
        bump,
    )]
    pub ticket: Box<Account<'info, OrderTicket>>,
    /// CHECK: the token program only moves funds the trader signed for, from an
    /// account of the same mint as the vault.
    #[account(mut)]
    pub trader_token: UncheckedAccount<'info>,
    /// CHECK: compared against book.base_vault / book.quote_vault in the handler.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    #[account(
        init_if_needed,
        space = 9,
        payer = trader,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Box<Account<'info, ArciumSignerAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_PLACE_ORDER))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("place_order_v2")]
#[derive(Accounts)]
pub struct PlaceOrderV2Callback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_PLACE_ORDER))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub book: Box<Account<'info, Book>>,
    #[account(mut)]
    pub ticket: Box<Account<'info, OrderTicket>>,
}

#[queue_computation_accounts("clear_v2", caller)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct ClearBatch<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, constraint = book.authority == caller.key() @ ErrorCode::Unauthorized)]
    pub book: Box<Account<'info, Book>>,
    /// CHECK: must be the book's canonical Pyth account for its primary feed; owner,
    /// discriminator, verification level and feed are checked in the handler.
    pub price_update: UncheckedAccount<'info>,
    /// CHECK: a Pyth update for the book's fallback feed; checked in the handler and
    /// only used when the primary price shows the exchange is closed.
    pub fallback_update: Option<UncheckedAccount<'info>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = caller,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_CLEAR))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("clear_v2")]
#[derive(Accounts)]
pub struct ClearV2Callback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_CLEAR))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub book: Box<Account<'info, Book>>,
}

#[init_computation_definition_accounts("init_book", payer)]
#[derive(Accounts)]
pub struct InitInitBookCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("place_order_v2", payer)]
#[derive(Accounts)]
pub struct InitPlaceOrderV2CompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("clear_v2", payer)]
#[derive(Accounts)]
pub struct InitClearV2CompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct BookReadyEvent {
    pub book: Pubkey,
}

#[event]
pub struct OrderPlacedEvent {
    pub book: Pubkey,
    pub order_count: u8,
}

#[event]
pub struct BatchClearedEvent {
    pub book: Pubkey,
    pub band_lo: u32,
    pub band_hi: u32,
    pub used_fallback: bool,
    pub clearing_price: u32,
    pub matched: u64,
    pub fills: [u64; MAX_ORDERS as usize],
}

#[event]
pub struct OrderFailedEvent {
    pub book: Pubkey,
    pub trader: Pubkey,
}

#[event]
pub struct ClearFailedEvent {
    pub book: Pubkey,
}

#[event]
pub struct PendingExpiredEvent {
    pub book: Pubkey,
    pub kind: u8,
}

#[event]
pub struct OrderCancelledEvent {
    pub book: Pubkey,
    pub slot: u8,
    pub trader: Pubkey,
}

#[event]
pub struct OrderSettledEvent {
    pub book: Pubkey,
    pub slot: u8,
    pub trader: Pubkey,
    pub base_out: u64,
    pub quote_out: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
    #[msg("Book is not open")]
    BookNotOpen,
    #[msg("A computation on this book is still pending")]
    ComputationPending,
    #[msg("Book is full")]
    BookFull,
    #[msg("Band lower bound exceeds upper bound")]
    InvalidBand,
    #[msg("Only the book authority can do this")]
    Unauthorized,
    #[msg("Lot size must be greater than zero")]
    InvalidLotSize,
    #[msg("Vaults are not open yet")]
    VaultsNotOpen,
    #[msg("Deposit exactly one token: quote for a buy, whole lots of base for a sell")]
    BadDeposit,
    #[msg("Vault does not belong to this book")]
    WrongVault,
    #[msg("Book has not been cleared")]
    NotCleared,
    #[msg("Order slot is empty or already settled")]
    NothingToSettle,
    #[msg("Token account does not belong to the slot's trader")]
    WrongTrader,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Not a Pyth price update account")]
    BadPriceAccount,
    #[msg("Pyth price update is not fully verified")]
    PriceNotFullyVerified,
    #[msg("Price update is for a different feed than this book")]
    WrongPriceFeed,
    #[msg("Reference price is too old")]
    StalePrice,
    #[msg("Pyth confidence interval is wider than the price band")]
    PriceTooUncertain,
    #[msg("Reference price does not fit the book's price units")]
    PriceOutOfRange,
    #[msg("Timeout must be greater than zero")]
    InvalidTimeout,
    #[msg("The book is not waiting on a computation")]
    NothingPending,
    #[msg("The pending computation has not timed out yet")]
    TimeoutNotReached,
    #[msg("This is not the ticket the book is waiting on")]
    WrongTicket,
    #[msg("Price was published before the last order entered the book")]
    PriceBeforeCutoff,
    #[msg("Primary price must be the canonical Pyth account for the book's feed")]
    WrongPriceAccount,
    #[msg("Exchange price is stale and no fallback price was provided")]
    MissingFallbackPrice,
    #[msg("Fallback needs a band at least as wide as the primary and a closed-market threshold above the max price age")]
    InvalidFallback,

}

#[cfg(test)]
mod price_tests {
    use super::*;

    fn account(level: u8, feed: [u8; 32], price: i64, conf: u64, exponent: i32, publish: i64) -> Vec<u8> {
        let mut d = PRICE_UPDATE_V2_DISCRIMINATOR.to_vec();
        d.extend_from_slice(&[7u8; 32]);
        d.push(level);
        if level == 0 {
            d.push(5);
        }
        d.extend_from_slice(&feed);
        d.extend_from_slice(&price.to_le_bytes());
        d.extend_from_slice(&conf.to_le_bytes());
        d.extend_from_slice(&exponent.to_le_bytes());
        d.extend_from_slice(&publish.to_le_bytes());
        d.extend_from_slice(&[0u8; 32]);
        d
    }

    #[test]
    fn reads_a_full_update() {
        let p = read_price_update(&account(1, [9; 32], 25_512_345, 1_000, -5, 1_700_000_000)).unwrap();
        assert_eq!(p.feed_id, [9; 32]);
        assert_eq!((p.price, p.conf, p.exponent, p.publish_time), (25_512_345, 1_000, -5, 1_700_000_000));
    }

    #[test]
    fn rejects_partial_updates_and_wrong_accounts() {
        assert!(read_price_update(&account(0, [9; 32], 1, 0, -5, 0)).is_err());
        let mut bad = account(1, [9; 32], 1, 0, -5, 0);
        bad[0] ^= 1;
        assert!(read_price_update(&bad).is_err());
        assert!(read_price_update(&[0u8; 50]).is_err());
    }

    fn price(price: i64, conf: u64, exponent: i32) -> PythPrice {
        PythPrice { feed_id: [0; 32], price, conf, exponent, publish_time: 0 }
    }

    #[test]
    fn converts_to_quote_atoms_per_lot() {
        // $255.12345 per share, 1 share lots (base 8 decimals), USDC quote (6 decimals).
        let (lo, hi) = price_band(&price(25_512_345, 1_000, -5), 100_000_000, 8, 6, 200).unwrap();
        assert_eq!((lo, hi), (250_020_981, 260_225_919));
        // $10.00000 per share, 10-atom lots, 0-decimal tokens.
        assert_eq!(price_band(&price(1_000_000, 10, -5), 10, 0, 0, 1_000).unwrap(), (90, 110));
    }

    fn at(feed: u8, publish_time: i64) -> PythPrice {
        PythPrice { feed_id: [feed; 32], price: 1_000_000, conf: 10, exponent: -5, publish_time }
    }

    fn rules() -> PriceRules {
        PriceRules {
            primary_feed: [1; 32],
            fallback_feed: [2; 32],
            max_age: 60,
            closed_after: 3_600,
            cutoff: 1_000,
            band_bps: 200,
            fallback_band_bps: 800,
        }
    }

    #[test]
    fn uses_the_exchange_price_when_fresh() {
        let (_, bps, fb) = select_reference(1_100, &rules(), &at(1, 1_090), Some(&at(2, 1_095))).unwrap();
        assert_eq!((bps, fb), (200, false));
    }

    #[test]
    fn refuses_prices_from_before_the_last_order() {
        assert!(select_reference(1_030, &rules(), &at(1, 990), None).is_err());
        let closed = at(1, 1_030 - 7_200);
        assert!(select_reference(1_030, &rules(), &closed, Some(&at(2, 999))).is_err());
    }

    #[test]
    fn falls_back_only_once_the_exchange_is_closed() {
        let now = 20_000;
        let (_, bps, fb) = select_reference(now, &rules(), &at(1, now - 7_200), Some(&at(2, now - 5))).unwrap();
        assert_eq!((bps, fb), (800, true));
        // Stale, but not long enough to call the market closed: no clear.
        assert!(select_reference(now, &rules(), &at(1, now - 600), Some(&at(2, now - 5))).is_err());
        // Closed, but no fallback supplied, or the fallback is itself stale.
        assert!(select_reference(now, &rules(), &at(1, now - 7_200), None).is_err());
        assert!(select_reference(now, &rules(), &at(1, now - 7_200), Some(&at(2, now - 120))).is_err());
        // Wrong feed in either slot.
        assert!(select_reference(now, &rules(), &at(9, now - 5), None).is_err());
        assert!(select_reference(now, &rules(), &at(1, now - 7_200), Some(&at(9, now - 5))).is_err());
    }

    #[test]
    fn no_fallback_configured_means_stale_exchange_price_blocks() {
        let mut r = rules();
        r.fallback_feed = [0; 32];
        assert!(select_reference(20_000, &r, &at(1, 10_000), Some(&at(2, 19_995))).is_err());
    }

    #[test]
    fn canonical_account_matches_pyth_sdk() {
        let aaplx: [u8; 32] = [
            0x97, 0x8e, 0x6c, 0xc6, 0x8a, 0x11, 0x9c, 0xe0, 0x66, 0xaa, 0x83, 0x00, 0x17, 0x31, 0x85, 0x63, 0xa9, 0xed,
            0x04, 0xec, 0x3a, 0x0a, 0x64, 0x39, 0x01, 0x0f, 0xc1, 0x12, 0x96, 0xa5, 0x86, 0x75,
        ];
        assert_eq!(
            canonical_price_account(&aaplx),
            pubkey!("Gs4DVtiGSJ9LJvXaQFjYp6vhLNK2QsH4qWox2ck1kuMp")
        );
    }

    #[test]
    fn rejects_uncertain_or_unrepresentable_prices() {
        assert!(price_band(&price(1_000_000, 200_000, -5), 10, 0, 0, 1_000).is_err());
        assert!(price_band(&price(-5, 0, -5), 10, 0, 0, 1_000).is_err());
        assert!(price_band(&price(1, 0, -5), 10, 0, 0, 1_000).is_err());
        assert!(price_band(&price(i64::MAX, 0, 0), u64::MAX, 0, 18, 100).is_err());
    }
}
