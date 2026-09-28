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
const COMP_DEF_OFFSET_PLACE_ORDER: u32 = comp_def_offset("place_order");
const COMP_DEF_OFFSET_CLEAR: u32 = comp_def_offset("clear");

pub const MAX_ORDERS: u8 = 16;
const BOOK_CIPHERTEXTS: usize = 9;
const ENCRYPTED_BOOK_OFFSET: u32 = 60;
const ENCRYPTED_BOOK_SIZE: u32 = 32 * BOOK_CIPHERTEXTS as u32;

pub const STATUS_OPEN: u8 = 0;
pub const STATUS_CLEARING: u8 = 1;
pub const STATUS_CLEARED: u8 = 2;

pub const TICKET_PENDING: u8 = 0;
pub const TICKET_LIVE: u8 = 1;
pub const TICKET_FAILED: u8 = 2;

// Circuits are too large to store on-chain cheaply, so Arx nodes fetch them from
// the public repo and verify them against the SHA-256 embedded at build time.
// Local tests build with `local-circuits`, where arcium pre-seeds them on-chain.
const CIRCUIT_BASE_URL: &str = "https://raw.githubusercontent.com/Ayoshiss/lattice-equities/main/circuits/";

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

    pub fn init_place_order_comp_def(ctx: Context<InitPlaceOrderCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, circuit_source("place_order", circuit_hash!("place_order")))?;
        Ok(())
    }

    pub fn init_clear_comp_def(ctx: Context<InitClearCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, circuit_source("clear", circuit_hash!("clear")))?;
        Ok(())
    }

    pub fn create_book(
        ctx: Context<CreateBook>,
        computation_offset: u64,
        book_id: u64,
        lot_size: u64,
    ) -> Result<()> {
        require!(lot_size > 0, ErrorCode::InvalidLotSize);
        let book = &mut ctx.accounts.book;
        book.bump = ctx.bumps.book;
        book.authority = ctx.accounts.authority.key();
        book.book_id = book_id;
        book.base_mint = ctx.accounts.base_mint.key();
        book.quote_mint = ctx.accounts.quote_mint.key();
        book.lot_size = lot_size;
        book.order_count = 0;
        book.status = STATUS_OPEN;
        book.pending = true;
        book.encrypted_book = [[0u8; 32]; BOOK_CIPHERTEXTS];

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
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(InitBookOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        let book = &mut ctx.accounts.book;
        book.encrypted_book = o.ciphertexts;
        book.state_nonce = o.nonce;
        book.pending = false;
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
        book.pending = true;

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
            vec![PlaceOrderCallback::callback_ix(
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

    #[arcium_callback(encrypted_ix = "place_order")]
    pub fn place_order_callback(
        ctx: Context<PlaceOrderCallback>,
        output: SignedComputationOutputs<PlaceOrderOutput>,
    ) -> Result<()> {
        let book = &mut ctx.accounts.book;
        let ticket = &mut ctx.accounts.ticket;
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(PlaceOrderOutput { field_0 }) => field_0,
            Err(_) => {
                // The order never reached the encrypted book. Unlock the book and let
                // the trader take the deposit back with refund_failed_order.
                ticket.status = TICKET_FAILED;
                book.pending = false;
                emit!(OrderFailedEvent { book: book.key(), trader: ticket.trader });
                return Ok(());
            }
        };
        ticket.status = TICKET_LIVE;
        book.encrypted_book = o.ciphertexts;
        book.state_nonce = o.nonce;
        book.order_count += 1;
        book.pending = false;
        emit!(OrderPlacedEvent { book: book.key(), order_count: book.order_count });
        Ok(())
    }

    /// Queues `clear` with the Pyth-derived band. The band is public; the book is not.
    pub fn clear_batch(
        ctx: Context<ClearBatch>,
        computation_offset: u64,
        band_lo: u32,
        band_hi: u32,
    ) -> Result<()> {
        let book = &mut ctx.accounts.book;
        require!(book.status == STATUS_OPEN, ErrorCode::BookNotOpen);
        require!(!book.pending, ErrorCode::ComputationPending);
        require!(band_lo <= band_hi, ErrorCode::InvalidBand);
        book.status = STATUS_CLEARING;
        book.pending = true;

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let args = ArgBuilder::new()
            .plaintext_u128(book.state_nonce)
            .account(book.key(), ENCRYPTED_BOOK_OFFSET, ENCRYPTED_BOOK_SIZE)
            .plaintext_u32(band_lo)
            .plaintext_u32(band_hi)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ClearCallback::callback_ix(
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

    #[arcium_callback(encrypted_ix = "clear")]
    pub fn clear_callback(
        ctx: Context<ClearCallback>,
        output: SignedComputationOutputs<ClearOutput>,
    ) -> Result<()> {
        let book = &mut ctx.accounts.book;
        let r = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(ClearOutput { field_0 }) => field_0,
            Err(_) => {
                // Reopen so the authority can retry the clear.
                book.status = STATUS_OPEN;
                book.pending = false;
                emit!(ClearFailedEvent { book: book.key() });
                return Ok(());
            }
        };
        book.clearing_price = r.field_0;
        book.matched = r.field_1;
        book.fills = r.field_2;
        book.status = STATUS_CLEARED;
        book.pending = false;
        emit!(BatchClearedEvent {
            book: book.key(),
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

        let authority = book.authority;
        let book_id = book.book_id.to_le_bytes();
        let bump = [book.bump];
        let seeds: &[&[u8]] = &[b"book", authority.as_ref(), &book_id, &bump];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.trader_token.to_account_info(),
                    authority: ctx.accounts.book.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
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

#[queue_computation_accounts("place_order", trader)]
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

#[callback_accounts("place_order")]
#[derive(Accounts)]
pub struct PlaceOrderCallback<'info> {
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

#[queue_computation_accounts("clear", caller)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct ClearBatch<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, constraint = book.authority == caller.key() @ ErrorCode::Unauthorized)]
    pub book: Box<Account<'info, Book>>,
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

#[callback_accounts("clear")]
#[derive(Accounts)]
pub struct ClearCallback<'info> {
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

#[init_computation_definition_accounts("place_order", payer)]
#[derive(Accounts)]
pub struct InitPlaceOrderCompDef<'info> {
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

#[init_computation_definition_accounts("clear", payer)]
#[derive(Accounts)]
pub struct InitClearCompDef<'info> {
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

}
