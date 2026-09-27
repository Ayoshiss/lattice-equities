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

// Circuits are too large to store on-chain cheaply, so Arx nodes fetch them from
// the public repo and verify them against the SHA-256 embedded at build time.
const CIRCUIT_BASE_URL: &str = "https://raw.githubusercontent.com/Ayoshiss/lattice-equities/main/build/";

declare_id!("AUXkwEowRX7BMPXGF1Ak2nC9Ni5SML7EU6fB6Jo1zvgm");

#[arcium_program]
pub mod lattice_equities {
    use super::*;

    pub fn init_init_book_comp_def(ctx: Context<InitInitBookCompDef>) -> Result<()> {
        init_computation_def(
            ctx.accounts,
            Some(CircuitSource::OffChain(OffChainCircuitSource {
                source: format!("{CIRCUIT_BASE_URL}init_book.arcis"),
                hash: circuit_hash!("init_book"),
            })),
        )?;
        Ok(())
    }

    pub fn init_place_order_comp_def(ctx: Context<InitPlaceOrderCompDef>) -> Result<()> {
        init_computation_def(
            ctx.accounts,
            Some(CircuitSource::OffChain(OffChainCircuitSource {
                source: format!("{CIRCUIT_BASE_URL}place_order.arcis"),
                hash: circuit_hash!("place_order"),
            })),
        )?;
        Ok(())
    }

    pub fn init_clear_comp_def(ctx: Context<InitClearCompDef>) -> Result<()> {
        init_computation_def(
            ctx.accounts,
            Some(CircuitSource::OffChain(OffChainCircuitSource {
                source: format!("{CIRCUIT_BASE_URL}clear.arcis"),
                hash: circuit_hash!("clear"),
            })),
        )?;
        Ok(())
    }

    pub fn create_book(ctx: Context<CreateBook>, computation_offset: u64, _book_id: u64) -> Result<()> {
        let book = &mut ctx.accounts.book;
        book.bump = ctx.bumps.book;
        book.authority = ctx.accounts.authority.key();
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
    ) -> Result<()> {
        let book = &mut ctx.accounts.book;
        require!(book.status == STATUS_OPEN, ErrorCode::BookNotOpen);
        require!(!book.pending, ErrorCode::ComputationPending);
        require!(book.order_count < MAX_ORDERS, ErrorCode::BookFull);
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
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![PlaceOrderCallback::callback_ix(
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

    #[arcium_callback(encrypted_ix = "place_order")]
    pub fn place_order_callback(
        ctx: Context<PlaceOrderCallback>,
        output: SignedComputationOutputs<PlaceOrderOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(PlaceOrderOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        let book = &mut ctx.accounts.book;
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
        let r = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(ClearOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        let book = &mut ctx.accounts.book;
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
}

#[queue_computation_accounts("init_book", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, book_id: u64)]
pub struct CreateBook<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
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
        init_if_needed,
        space = 9,
        payer = trader,
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
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_PLACE_ORDER))]
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
    #[msg("Only the book authority can clear")]
    Unauthorized,
}
