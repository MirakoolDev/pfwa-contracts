# PRD: Order book markets

**Status:** contracts and the NEAR Intents flow built and tested, front end next (see Progress) · **Owner:** Miracle · **Target:** NEAR Hackathon submission, 14 Nov 2026, 23:59 UTC
**Technical spec:** `docs/spec-order-book-markets.md`

## Progress (Nov 2 2026)

- **Built and tested** in [`orderbook/`](../orderbook): the factory, markets, outcome tokens, the hook, our own limit orders, the resolver with the dispute window, the fee collector and the NEAR Intents forwarder. 37 tests pass, plus a fork test of a market's whole life against the real PoolManager and USDG.
- **NEAR Intents** in [`orderbook/intents/`](../orderbook/intents): the 1Click client, order planning, the keeper and a CLI. Run end to end on a fork with live 1Click prices: 0.1 SOL → about 9.03 USDG → 14.66 YES in the buyer's wallet.
- **Next:** the front end (spec §10), then mainnet once every fee, cap and bond is confirmed, a small real trade from another chain, and the demo video.
- **Waiting on:** the launch fee rates, the per-market deposit cap, the arbitration multisig's signers, and a NEAR Intents partner key.

## Summary

PFWA markets today trade on bonding curves. This adds a second engine, **order book markets**. Each outcome is a token backed 1:1 by USDG and trades in a Uniswap v4 pool, through a PFWA hook that keeps prices between 0 and 1 and fills limit orders inside swaps. Creators choose the engine when they create a market.

Market types, templates, data sources and the create flow stay the same. Two things are new:
- a **dispute window**, so a wrong resolution can be challenged before it pays out
- **NEAR Intents**, so anyone can trade from any chain

## Why

- **Prices people already understand.** On a bonding curve, the share of ETH in an outcome isn't a probability, and buying the popular side late can lose money even when it wins. On an order book, 0.62 means 62%, and a winning token always pays exactly 1 USDG.
- **Stable payouts.** Markets priced in ETH move with ETH. USDG markets pay in dollars, and later in a yield-earning dollar, which makes long-dated markets worth holding.
- **Limit orders.** "Buy YES if it drops to 30%" and "sell if it hits 80%" are what active traders expect. Bonding curves can't do this.
- **Disputes.** Today the creator or the resolver bot decides the outcome, and the decision is final. A challenge window with bonds makes a wrong call costly and gives traders a way to fix it.
- **Any chain.** With NEAR Intents, someone holding SOL, BTC or USDC on another chain can trade a PFWA market in one step.

## Users and use cases

| User | Wants to | Order book markets let them |
|---|---|---|
| Trader | Bet at a fair, readable price | Buy YES at 0.40 and get 1 USDG if right |
| Active trader | Set entries and exits | Place limit orders that fill automatically |
| Creator | Launch a market and earn | Pick bonding curve or order book, then earn fees on every trade |
| Liquidity provider | Earn from market making | Mint complete sets and provide liquidity in the outcome pools |
| Anyone on another chain | Trade without bridging | Pay with SOL, BTC or USDC through NEAR Intents |
| Any trader | Challenge a wrong result | Post a bond to dispute it during the challenge window |

## Scope

### Must have (hackathon)
1. **Engine choice when creating a market:** bonding curve (unchanged) or order book.
2. **Order book markets** with 2–10 outcomes:
   - priced in USDG
   - mint a complete set for 1 USDG, and burn one to get 1 USDG back
   - one v4 pool per outcome against USDG
3. **The PFWA hook:**
   - only the factory can create pools on it
   - prices stay between 0.001 and 0.999
   - trading closes at the end of trading, or as soon as a result is posted
   - it takes a trading fee inside the swap, on the USDG side
4. **Resolution, as today, plus a dispute window:**
   1. The market resolves exactly as bonding curve markets do: the resolver bot from the data source, or the creator, or the PFWA owner. Posting the result stops trading.
   2. For 2 hours anyone can dispute it by posting a 50 USDG bond. The PFWA multisig then confirms or corrects it; a disputer who was right gets the bond back, one who was wrong loses it.
   3. With no dispute, the result is final when the window closes, and winners redeem.
5. **Fees:** a creator fee (set by the creator, at most 2%) and a protocol fee (at most 2%; the launch rate is still to confirm) on every swap. The protocol share buys back $PFWA, swapping USDG for $PFWA on Robinhood Chain and sending it to the PFWA treasury.
6. **NEAR Intents:** deposit from any supported chain into a market position, and withdraw winnings back to any chain.
7. **Front end** (plan in spec §10):
   - the engine choice in the create flow
   - an order book market page with price chart, buy/sell, limit orders and the user's positions
   - a "pay from any chain" window, and "withdraw to any chain" from the portfolio
   - a dispute banner and button during the challenge window

8. **Limit orders** that fill inside swaps, with our own order book (`PFWALimitOrders`).

### Should have
- **The MM agent quoting order book markets,** so new markets aren't empty.

### Later
- A yield-earning collateral option (an ERC-4626 vault over USDG, or another yield-bearing stablecoin on Robinhood Chain).
- A funding phase: a market only opens for trading once enough USDG backs it, which also sets its opening odds.
- Escalating disputes past the multisig to $PFWA holders.
- Order book markets on Solana.

### Not changing
Market templates, data sources, the setup fingerprint, the resolver bot's data checks, XP, usernames, referrals and fraud watch. Existing bonding curve markets keep working exactly as they do.

## User flows

**Create**
1. The creator picks a template, as today.
2. They choose an engine: bonding curve or order book.
3. For an order book market, they set the opening price per outcome (default: even) and optionally seed liquidity in USDG.
4. They pay the creation fee, and the factory deploys the market, its outcome tokens and pools.

**Trade**
- Buy or sell an outcome at the current price, or place a limit order.
- Or mint a complete set and sell the outcomes you don't want.

**Trade from another chain**
1. Pick the market and outcome, then the chain and token you hold.
2. You get a quote and a one-time deposit address.
3. After you send funds, NEAR Intents swaps them into USDG on Robinhood Chain and the position lands in your wallet.

**Resolve and dispute**
1. The resolver bot (for data markets), the creator or the PFWA owner resolves the market, as today. Trading stops.
2. The market shows "Resolved: YES, final in 2h".
3. Anyone can dispute in that window by posting a 50 USDG bond; the PFWA multisig settles it.
4. When the outcome is final, winners redeem 1 USDG per token. Claims to another chain go back through NEAR Intents.

## Success metrics (first 30 days after launch)

- At least 25% of new markets choose the order book engine.
- At least 20% of order book volume arrives through NEAR Intents from another chain.
- Fewer than 2% of resolutions are disputed, and every dispute is settled within 48 hours.
- No loss of user funds.

## Risks

- **Empty markets.** A new order book market has no liquidity until someone provides it. Mitigation: creator seeding, the MM agent and (later) the funding phase.
- **Contract risk.** New contracts holding user funds. Mitigation: tests, a capped deposit size for the hackathon launch, and an audit before lifting the cap.
- **Admin trust.** The arbitration multisig and the factory owner (who sets the fee and bond for new markets and the deposit cap, and can pause new market creation) are trust points. Live markets can't be paused and their fees can't be changed. Document them clearly, and move arbitration to $PFWA holders later.
- **Regulation.** Dollar-denominated outcome tokens look more like regulated event contracts than ETH bets do. Keep the existing region restrictions and terms.
- **NEAR Intents dependency.** If a solver doesn't fill, the user is refunded on the source chain. The UI has to show that state clearly.

## Open questions

1. ~~Confirm that the USDG address NEAR Intents lists for Robinhood Chain (`0x5fc5…d168`) is the official one.~~ Checked onchain Nov 2: it's Global Dollar (USDG), 6 decimals, and 1Click lists it on `hood`.
2. Which yield-earning stablecoin, if any, is live on Robinhood Chain?
3. ~~Bond size: a flat amount, or scaled to the market's volume?~~ Decided: a flat 50 USDG, fixed per market at creation (the owner can change the default for new markets).
4. Who signs on the arbitration multisig?
5. Should the protocol's $PFWA buyback keep the tokens in the treasury, burn them, or route them to the holder pool? The fee collector supports hold or burn; it's set when it's deployed, and the default is hold.
6. The launch fee rates and the per-market deposit cap.
