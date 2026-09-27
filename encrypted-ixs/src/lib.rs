use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    pub const N: usize = 16;
    const BUY: u8 = 1;

    pub struct Order {
        pub side: u8,
        pub price: u32,
        pub qty: u64,
    }

    // Empty slots have qty 0, so they never add volume or become a candidate price.
    pub struct Book {
        pub sides: [u8; N],
        pub prices: [u32; N],
        pub qtys: [u64; N],
        pub count: u8,
    }

    type PackedBook = Pack<Book>;

    pub struct ClearResult {
        pub price: u32,
        pub matched: u64,
        pub fills: [u64; N],
    }

    #[instruction]
    pub fn init_book() -> Enc<Mxe, PackedBook> {
        Mxe::get().from_arcis(Pack::new(Book {
            sides: [0u8; N],
            prices: [0u32; N],
            qtys: [0u64; N],
            count: 0u8,
        }))
    }

    #[instruction]
    pub fn place_order(order_ctxt: Enc<Shared, Order>, book_ctxt: Enc<Mxe, PackedBook>) -> Enc<Mxe, PackedBook> {
        let order = order_ctxt.to_arcis();
        let mut book = book_ctxt.to_arcis().unpack();
        for i in 0..N {
            if book.count == i as u8 {
                book.sides[i] = order.side;
                book.prices[i] = order.price;
                book.qtys[i] = order.qty;
            }
        }
        if (book.count as usize) < N {
            book.count += 1;
        }
        book_ctxt.owner.from_arcis(Pack::new(book))
    }

    #[instruction]
    pub fn clear(book_ctxt: Enc<Mxe, PackedBook>, band_lo: u32, band_hi: u32) -> ClearResult {
        let book = book_ctxt.to_arcis().unpack();
        let (price, matched, fills) = clear_book(book.sides, book.prices, book.qtys, band_lo, band_hi);
        ClearResult { price, matched, fills }.reveal()
    }

    fn better_of(v1: u64, p1: u32, v2: u64, p2: u32) -> (u64, u32) {
        let take_second = v2 > v1 || (v2 == v1 && p2 < p1);
        if take_second { (v2, p2) } else { (v1, p1) }
    }

    // Uniform-price call auction. Candidate prices are the submitted limits inside
    // [band_lo, band_hi]; pick the one matching the most volume, lower price on ties.
    // The smaller side fills fully; the larger side is rationed in arrival order.
    // Written so MPC work runs in parallel: one comparison matrix, a knockout
    // tournament for the winner, and prefix sums for the fills.
    pub fn clear_book(
        sides: [u8; N],
        prices: [u32; N],
        qtys: [u64; N],
        band_lo: u32,
        band_hi: u32,
    ) -> (u32, u64, [u64; N]) {
        let mut is_buy = [false; N];
        for i in 0..N {
            is_buy[i] = sides[i] == BUY;
        }

        // ge[i][j] = prices[i] >= prices[j]; prices[i] <= prices[j] is ge[j][i].
        let mut ge = [[true; N]; N];
        for i in 0..N {
            for j in 0..N {
                if i != j {
                    ge[i][j] = prices[i] >= prices[j];
                }
            }
        }

        let mut vols = [0u64; N];
        for j in 0..N {
            let mut buy_vol: u64 = 0;
            let mut sell_vol: u64 = 0;
            for i in 0..N {
                if is_buy[i] && ge[i][j] {
                    buy_vol += qtys[i];
                }
                if !is_buy[i] && ge[j][i] {
                    sell_vol += qtys[i];
                }
            }
            let matched = if buy_vol < sell_vol { buy_vol } else { sell_vol };
            let candidate = qtys[j] > 0 && prices[j] >= band_lo && prices[j] <= band_hi;
            vols[j] = if candidate { matched } else { 0 };
        }

        let mut best_vols = vols;
        let mut best_prices = prices;
        for level in 0..8 {
            let step = 1usize << level;
            if step < N {
                for k in 0..N {
                    if k % (2 * step) == 0 && k + step < N {
                        let (v, p) = better_of(best_vols[k], best_prices[k], best_vols[k + step], best_prices[k + step]);
                        best_vols[k] = v;
                        best_prices[k] = p;
                    }
                }
            }
        }
        let best_vol = best_vols[0];
        let best_price = if best_vol > 0 { best_prices[0] } else { 0 };

        let mut fills: [u64; N] = [0; N];
        let mut buy_before: u64 = 0;
        let mut sell_before: u64 = 0;
        for i in 0..N {
            let q = qtys[i];
            let buy_ok = best_vol > 0 && is_buy[i] && prices[i] >= best_price;
            let sell_ok = best_vol > 0 && !is_buy[i] && prices[i] <= best_price;
            let before = if is_buy[i] { buy_before } else { sell_before };
            let room = if before >= best_vol { 0 } else { best_vol - before };
            let fill = if q < room { q } else { room };
            if buy_ok || sell_ok {
                fills[i] = fill;
            }
            if buy_ok {
                buy_before += q;
            }
            if sell_ok {
                sell_before += q;
            }
        }
        (best_price, best_vol, fills)
    }
}

#[cfg(test)]
mod clearing_tests {
    use super::circuits::{clear_book, N};

    const WIDE: (u32, u32) = (0, u32::MAX);

    fn book(orders: &[(u8, u32, u64)]) -> ([u8; N], [u32; N], [u64; N]) {
        let mut s = [0u8; N];
        let mut p = [0u32; N];
        let mut q = [0u64; N];
        for (i, (side, price, qty)) in orders.iter().enumerate() {
            s[i] = *side;
            p[i] = *price;
            q[i] = *qty;
        }
        (s, p, q)
    }

    // Straightforward sequential version of the same rules, kept as the spec.
    fn reference(s: [u8; N], p: [u32; N], q: [u64; N], lo: u32, hi: u32) -> (u32, u64, [u64; N]) {
        let (mut best_p, mut best_v) = (0u32, 0u64);
        for j in 0..N {
            let buy: u64 = (0..N).filter(|&i| s[i] == 1 && p[i] >= p[j]).map(|i| q[i]).sum();
            let sell: u64 = (0..N).filter(|&i| s[i] != 1 && p[i] <= p[j]).map(|i| q[i]).sum();
            let m = buy.min(sell);
            let cand = q[j] > 0 && p[j] >= lo && p[j] <= hi;
            if cand && (m > best_v || (m == best_v && m > 0 && p[j] < best_p)) {
                best_v = m;
                best_p = p[j];
            }
        }
        let mut fills = [0u64; N];
        let (mut buy_left, mut sell_left) = (best_v, best_v);
        for i in 0..N {
            if best_v == 0 {
                break;
            }
            if s[i] == 1 && p[i] >= best_p {
                fills[i] = q[i].min(buy_left);
                buy_left -= fills[i];
            } else if s[i] != 1 && p[i] <= best_p {
                fills[i] = q[i].min(sell_left);
                sell_left -= fills[i];
            }
        }
        (best_p, best_v, fills)
    }

    #[test]
    fn balanced_cross_fills_everyone_at_one_price() {
        let (s, p, q) = book(&[(1, 102, 10), (0, 99, 10)]);
        let (price, matched, fills) = clear_book(s, p, q, WIDE.0, WIDE.1);
        assert_eq!(matched, 10);
        assert_eq!(price, 99);
        assert_eq!(&fills[..2], &[10, 10]);
    }

    #[test]
    fn excess_demand_is_rationed_not_overfilled() {
        let (s, p, q) = book(&[(1, 105, 8), (1, 103, 8), (0, 100, 10)]);
        let (price, matched, fills) = clear_book(s, p, q, WIDE.0, WIDE.1);
        assert_eq!(matched, 10);
        assert_eq!(price, 100);
        assert_eq!(&fills[..3], &[8, 2, 10]);
    }

    #[test]
    fn orders_outside_the_limit_do_not_fill() {
        let (s, p, q) = book(&[(1, 101, 5), (1, 90, 5), (0, 100, 5), (0, 120, 5)]);
        let (price, matched, fills) = clear_book(s, p, q, WIDE.0, WIDE.1);
        assert_eq!(matched, 5);
        assert_eq!(price, 100);
        assert_eq!(&fills[..4], &[5, 0, 5, 0]);
    }

    #[test]
    fn no_cross_means_no_fills() {
        let (s, p, q) = book(&[(1, 95, 5), (0, 100, 5)]);
        let (price, matched, fills) = clear_book(s, p, q, WIDE.0, WIDE.1);
        assert_eq!((price, matched), (0, 0));
        assert_eq!(fills, [0; N]);
    }

    #[test]
    fn band_rejects_prices_outside_the_reference_range() {
        let (s, p, q) = book(&[(1, 130, 5), (0, 125, 5)]);
        let (price, matched, fills) = clear_book(s, p, q, 98, 102);
        assert_eq!((price, matched), (0, 0));
        assert_eq!(fills, [0; N]);
    }

    #[test]
    fn band_picks_an_in_band_price_when_one_exists() {
        let (s, p, q) = book(&[(1, 104, 5), (1, 101, 5), (0, 97, 5), (0, 100, 5)]);
        let (price, matched, _) = clear_book(s, p, q, 99, 102);
        assert_eq!(matched, 10);
        assert!(price >= 99 && price <= 102);
    }

    #[test]
    fn matches_reference_on_random_books() {
        let mut seed: u64 = 0x9E3779B97F4A7C15;
        let mut next = |m: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % m
        };
        for _ in 0..20_000 {
            let n = next(N as u64 + 1) as usize;
            let mut orders = Vec::new();
            for _ in 0..n {
                orders.push((next(2) as u8, 90 + next(21) as u32, 1 + next(50)));
            }
            let (s, p, q) = book(&orders);
            let (lo, hi) = if next(3) == 0 { (95 + next(5) as u32, 100 + next(6) as u32) } else { WIDE };
            let got = clear_book(s, p, q, lo, hi);
            assert_eq!(got, reference(s, p, q, lo, hi), "book {:?} band {:?}", orders, (lo, hi));
            let bought: u64 = (0..N).filter(|&i| s[i] == 1).map(|i| got.2[i]).sum();
            let sold: u64 = (0..N).filter(|&i| s[i] != 1).map(|i| got.2[i]).sum();
            assert_eq!((bought, sold), (got.1, got.1));
        }
    }
}
