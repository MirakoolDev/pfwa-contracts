# Spec: Order book markets

**Status (Nov 2 2026):** contracts built and tested in `orderbook/` (38 tests, plus a fork test of a market's whole life); the NEAR Intents flow built in `orderbook/intents/` and run end to end on a fork; not deployed; the front end not started (plan in §10) · **Product doc:** `docs/prd-order-book-markets.md`
**Chain:** Robinhood Chain (4663) · **Collateral:** USDG (6 decimals)

## 1. Overview

A new, separate factory deploys **order book markets**:

- An order book market has N outcome tokens (2–10), each fully backed by USDG.
- **Complete sets:** depositing `x` USDG mints `x` of every outcome token, and burning `x` of every outcome returns `x` USDG.
- **Trading:** each outcome trades in its own Uniswap v4 pool, `OUTCOME_i / USDG`, through one shared PFWA hook.
- **Resolution:** as on bonding curve markets, plus a 2-hour dispute window with a bond. After resolution, each winning token redeems for 1 USDG.

The existing bonding curve factory (`0x7B38…4afa`) stays untouched. The front end reads both factories and shows the engine per market.

### Existing infrastructure on Robinhood Chain

| Contract | Address |
|---|---|
| Uniswap v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| Universal Router | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| V4 Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| $PFWA | `0xa934bA4F59070149d37A93F8A002Af79BAe35563` |
| USDG (to confirm) | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` |

## 2. Contracts

| Contract | Job |
|---|---|
| `OBMarketFactory` | Creates markets: clones the outcome tokens, initialises the pools, registers the market with the resolver, collects the creation fee. Holds no user funds. |
| `OBMarket` (EIP-1167 clone) | Holds a market's USDG. Mints and burns complete sets, and pays redemptions after resolution. |
| `OutcomeToken` (EIP-1167 clone) | An ERC-20 with 6 decimals, the same as USDG, so 1 token = 1 USDG at par. Only its `OBMarket` can mint or burn. |
| `PFWAMarketHook` | The single v4 hook for every order book pool. |
| `PFWALimitOrders` | Limit orders, our own (see §6). |
| `MarketResolver` | Resolution as on bonding curve markets, a 2-hour dispute window with a bond, and the final outcome. |
| `FeeCollector` | Receives protocol fees in USDG, and runs the $PFWA buyback. |
| `ForwarderFactory` and `IntentDeposit` (in `IntentForwarder.sol`) | NEAR Intents entry: a one-time deposit address per order, which a keeper turns into outcome tokens (see §8). |

Use Foundry. Clone pattern as in the existing factory.

## 3. Markets and complete sets

```solidity
struct MarketConfig {
    bytes32 setupHash;        // same setup fingerprint as bonding curve markets
    uint64  endOfTrading;     // trading closes for good at this time (or earlier, when a result is posted)
    uint8   outcomeCount;     // 2..10
    address creator;
    uint16  creatorFeeBps;    // set by the creator, at most 100 (1%)
    uint16  protocolFeeBps;   // the factory's current rate, at most 200 (2%); the launch rate is still to confirm
}

// OBMarket
function mintSet(uint256 amount, address to) external;    // pull `amount` USDG, mint `amount` of every outcome
function burnSet(uint256 amount, address to) external;    // burn `amount` of every outcome, return `amount` USDG (before resolution)
function redeem(uint256 amount, address to) external;     // after resolution: burn winning tokens, pay 1 USDG each
```

**Invariant:** `USDG.balanceOf(market) == totalSupply(any outcome)` before resolution, and `>= totalSupply(winner) - redeemed` after it. Fuzz-test this.

- **Market IDs** start at `200000` so they never collide with the bonding curve factories.
- **Creation fee:** a flat USDG amount, sent to `FeeCollector`.
- **Rules onchain:** `createMarket` takes the market's rules (how the outcome is decided, and from what source), 1 to 2,000 bytes, and the factory stores them with the market (`getMarket(id).rules`) and logs them in `MarketRules(id, rules)`. Disputes are judged against them, and nobody can change them after creation. `setupHash` stays the fingerprint of the whole setup.

## 4. Pools

For each outcome `i`:
- **Pool key:** `{currency0, currency1} = sort(OUTCOME_i, USDG)`, `fee = 0` (the hook charges the fee), `tickSpacing = 10`, `hooks = PFWAMarketHook`.
- **Initial price:** set from the creator's opening probability. The default is an even 1/N.
- **Seeding (creator liquidity):** the creator is the market's liquidity provider and is paid by the creator fee (pools charge no LP fee). On pfwa.fun the creator must add at least 100 USDG right after creating the market, through `LiquidityLocker.seed`: one call mints complete sets and opens one PositionManager position per pool, from 20 points under to 20 points over the opening chance, with the NFTs held by the locker. They can't be taken out while `OBMarket.tradingOpen()` is true; after that `release` returns them to the creator, who withdraws as usual. The 100 USDG minimum is an app rule (the site lists and resolves only markets that meet it); the lock is enforced by the contract. Anyone else can still add liquidity directly through the PositionManager, unlocked and unpaid.

**Price bounds:** each outcome must trade between `P_MIN = 0.001` and `P_MAX = 0.999` USDG. Convert to ticks once per pool at creation and store them; mind the token order, since the bound flips when `OUTCOME_i` is `currency1`.

## 5. PFWAMarketHook

**Permissions**
```
beforeInitialize: true        // only the factory may create pools
beforeSwap: true              // trading-open check, store the starting tick, fee when USDG is the specified side
afterSwap: true               // bounds check, fill limit orders, fee when USDG is the unspecified side
beforeSwapReturnDelta: true
afterSwapReturnDelta: true
others: false
```

**`beforeInitialize`:** revert unless `sender == OBMarketFactory`.

**`beforeSwap`**
1. Revert unless the market is open: before `endOfTrading` and not resolved. There's no pause switch; trading closes at `endOfTrading` and never reopens, so disputes don't need to pause anything.
2. Store the current tick in transient storage (EIP-1153 `tstore`).
3. If USDG is the swap's specified currency, take the fee from it through `BeforeSwapDelta`.

**`afterSwap`**
1. Read the new tick from `slot0`, and revert if it's outside the pool's stored bounds.
2. If USDG is the unspecified currency, take the fee from it through the returned `int128` delta.
3. Report the move to the limit-order manager (see §6).

**Fees.** Always charge on the USDG leg, so fees are never held in outcome tokens. Split the fee by `creatorFeeBps : protocolFeeBps`:
- Both shares are held in the hook. Creators withdraw theirs with `claimCreatorFees`, and anyone can sweep the protocol's to `FeeCollector`. Fees are pulled rather than paid inside the swap, because USDG can freeze addresses and a frozen creator would otherwise block the market.
- The protocol's share goes to `FeeCollector`.
- Fee rates are fixed per market at creation, so there's no admin setter for a live market.

**Admin surface.** Keep it minimal:
- **The factory** may register and open pools.
- **There is no global fee setter and no validator swap.** Fewer trust points than a generic hook.

## 6. Limit orders

`PFWALimitOrders`, written for these pools. No owner, no admin, no fee.

- **An order** is one-sided liquidity in a single tick-spacing step on the far side of the price: selling currency0 sits above the price, selling currency1 below it. It must sit inside the pool's price bounds, and only while the market trades.
- **Orders at the same step and direction share one position** (an epoch), so a fill costs the same however many traders are in it. Each trader withdraws their share of what it turned into.
- **Filling:** after every swap the hook calls `movePoolTick(key, fromTick, toTick, sqrtPriceX96)` with the tick it stored in `beforeSwap`. The book finds the steps the price fully crossed (a tick bitmap per pool and direction) and removes their liquidity inside the same transaction, up to 8 per swap. Anyone can fill the rest with `fill` while the price is still past them; if it comes back first, those orders stay open.
- **Cancel** an unfilled order any time, also after the market closes; **withdraw** a filled one any time.
- Makers pay no fee; the swap that fills an order already paid the market's fee on its USDG leg.

## 7. MarketResolver

Resolution works the way PFWA's bonding curve markets resolve today; the only addition is one short dispute step before winners can redeem.

```
Open ──resolveMarket(outcome)──▶ Pending (trading stops) ──2 hours, no dispute──▶ finalize() ──▶ Final
Pending ──dispute() + bond──▶ Disputed ──settleDispute(outcome), by the arbiter──▶ Final
```

**Who resolves:** the same rule as `PFWAMarketFactory.resolveMarket`: the market's creator, the relayer (the resolver bot reading the market's data source) for platform markets, the owner, and the relayer or owner once the market is 24 hours past its end of trading. A data source can settle a market before its deadline (instant results), and posting a result stops trading at once.

**Disputes:** for 2 hours after a result is posted, anyone can dispute it by posting the market's bond (50 USDG by default, set per market at creation). The arbiter then confirms or corrects the result. The arbiter only settles disputes: it starts as the owner (the PFWA multisig), and the owner can point it at another address with `setArbiter`, such as a $PFWA holder vote later, without handing over any other power. A disputer who was right gets the bond back; one who was wrong loses it to `FeeCollector`. No dispute: anyone calls `finalize()` when the window ends.

**`INVALID` outcome:** every outcome token redeems for `1/N` USDG, rounded down so the total paid never exceeds the market's balance.

**After finalising:** the resolver calls `OBMarket.finalize(outcome)`, which enables `redeem`.

## 8. NEAR Intents (cross-chain trading)

NEAR Intents' 1Click API lists Robinhood Chain as `hood`, with ETH, WETH and USDG.

**Buy from another chain** (built: `src/IntentForwarder.sol`, and the off-chain side in `orderbook/intents/`)
1. **Price it.** A dry `POST /v0/quote` prices the user's asset in USDG on Robinhood Chain (`nep141:hood-0x5fc5…d168.omft.near`).
2. **Fix the order.** The V4 Quoter prices that USDG in the outcome, through the hook so the fee is included; minus slippage, that's `minOut`. The order is `(user, marketId, outcome, minOut, deadline, nonce)`, with a 3-hour deadline. `ForwarderFactory.depositAddress(order)` gives its deposit address on Robinhood Chain (a CREATE2 clone of `IntentDeposit`, salted by the order).
3. **Open the swap.** A live quote with that deposit address as the recipient, and refunds to the user's own address on the origin chain. The user sends their asset to the 1Click deposit address on their chain. `POST /v0/deposit/submit` with the transaction hash speeds it up.
4. **A keeper executes.** It watches `GET /v0/status` and the deposit address's USDG balance. Once USDG lands it calls `ForwarderFactory.execute(order)`, which deploys the clone if needed, swaps all its USDG into the outcome through the PoolManager, and sends the tokens to the user. A swap stops at the pool's price bound (0.999) instead of failing, and any USDG it couldn't spend goes back to the user. Fewer than `minOut` tokens reverts.
5. **Refunds.** The user can call `refund(order)` at any time, and anyone can once the deadline has passed; the USDG goes to the user on Robinhood Chain, and the UI then offers a withdraw back through 1Click. The keeper refunds expired orders itself.

**Withdraw to another chain**
1. The user redeems or sells for USDG.
2. They get a 1Click quote with origin USDG on `hood` and their chosen destination asset.
3. They send the USDG to the deposit address from their wallet.

**Notes**
- Get a partner key from partners.near-intents.org and use it for every quote; without one every quote carries an extra 0.25%. The key stays on the server.
- Each user's Robinhood Chain address is their connected EVM wallet. Users without one are prompted to connect or create one.
- The keeper holds no funds: `execute` only pays the order's user at or above `minOut`, and `refund` only pays the user.
- Tested: 9 unit tests (`npm test` in `orderbook/intents`), and `e2e/fork.sh` runs the whole flow on a fork with live 1Click prices (0.1 SOL → about 9.03 USDG → 14.66 YES). The fork run never opens a real deposit address.

## 9. FeeCollector and the $PFWA buyback

- **Fees in:** protocol swap fees, creation fees and slashed-bond shares, all in USDG.
- **`buyback(minOut)`:**
  1. Only the owner or the keeper can call it, at most once an hour. If anyone could call it, they could pass a `minOut` of 0 and sandwich the swap.
  2. It swaps the accumulated USDG into WETH, then WETH into $PFWA, through Uniswap's V3 SwapRouter02 (`0xcaf681a66d020601342297493863e78c959e5cb2`): USDG/WETH 0.01%, then the $PFWA/WETH 1% Pons pool, $PFWA's deepest. `minOut` comes from a keeper quote. The route and its liquidity are in the [orderbook README](../orderbook/README.md#launch-settings).
  3. It sends the $PFWA to `PFWA_TREASURY`.
  4. Burning versus holding is a constructor setting; the default is hold.
- **Event:** `Buyback(usdgIn, pfwaOut)`.

## 10. Off-chain changes

**Indexer and API**
- Add the new factory's markets to `/api/markets/live`, with `engine: 'curve' | 'book'`.
- For order book markets, `chance` is the outcome's pool price × 100.

**Resolver bot**
- Call `MarketResolver.resolveMarket` for order book markets, as it calls the factory's `resolveMarket` today.
- Keep the two-checks-an-hour-apart rule before resolving.
- Call `finalize` once the 2-hour window passes, and alert the multisig when a result is disputed.

**MM agent (should have)**
- Quote both sides around its fair-value estimate by placing limit orders, and refresh them as data changes.

**Front end** (the app repo, `frontend/src`; built as `/book`, `/book/create` and `/book/[id]`, steps 1–2 and 7–8 still to do)

The app reads markets live over RPC with multicall (no subgraph), uses wagmi, viem and RainbowKit, and keeps trades and positions in Postgres through Prisma.

1. **Config and ABIs.** New env vars for the factory, hook, resolver, limit orders and forwarder; ABIs from `orderbook/out` into `lib/abi.ts`. Order book markets keep their onchain IDs (200000 and up), clear of the legacy range (below 100000) and V2's (100000 + onchain ID).
2. **Markets API** (`api/markets/live/route.ts`). A third loop over the new factory: `getMarket`, `getPools`, each pool's price from StateView, the resolver's state. Every market gets `engine: 'curve' | 'book'`; for a book market `chance` is the pool price × 100 and amounts are in USDG. Add an `engine` column to `LiveOracleMarket` (default `curve`) and a currency to `Trade`.
3. **Indexer** (`api/cron/index-trades`, `lib/recordTrade.ts`). Index the PoolManager's `Swap` events for our pools, and the limit-order and resolver events, into `Trade` and `Position`.
4. **Create** (`app/create/page.tsx`). An engine toggle next to the template tabs. For an order book market: an opening price per outcome (default even), an optional USDG seed and the creator fee (up to 1%). `handleCreate` branches to a USDG approve plus `createMarket`; the setup signature, `/api/markets/pending` and the oracle registration stay as they are.
5. **Market page** (`app/market/[id]/page.tsx`). A new trade panel beside `OrderSlip.tsx`:
   - buy and sell at the pool price, through the Universal Router's v4 swap, with a USDG approve (Permit2)
   - limit orders: place, cancel, withdraw, and the user's open orders
   - mint and burn a full set
   - redeem after the result is final

   The chart keeps the same `LineChart`, fed by indexed swaps. A dispute banner shows "Resolved: YES, final in 1h 43m", with a Dispute button (approve 50 USDG, then `dispute`), and Finalize once the window ends.
6. **Pay from any chain.** A modal on the market page: pick a coin from 1Click's list, see the quote, get the deposit address (with a QR code), and watch the status until the tokens arrive. Server routes `/api/intents/quote` and `/api/intents/status` reuse `orderbook/intents/src` and keep the partner key server side. The keeper runs as a cron route with the relayer key, with an `IntentOrder` table instead of the JSON file.
7. **Portfolio.** Book positions in USDG, open limit orders, winnings to redeem, and "withdraw to any chain".
8. **Resolver bot** (`api/cron/resolve-tokens`, `api/cron/instant-resolve`). For book markets call `MarketResolver.resolveMarket`. A new step calls `finalize` once the 2 hours pass and alerts the multisig when a result is disputed. `LiveOracleMarket` gains the states between posted and final.

Rough size: 4–5 days, the market page and the pay-from-any-chain modal being the largest.

## 11. Testing

1. **Unit tests:**
   - set mint and burn
   - redemption, including `INVALID` rounding
   - hook bounds, the trading window and the fee in both swap directions and both token orders
   - every resolver state transition
2. **Invariant and fuzz tests:**
   - collateral always covers redemptions
   - fees never exceed the configured rate
   - no swap ends outside the bounds
3. **A fork test** against Robinhood Chain mainnet: create a market, seed it, swap through the Universal Router, resolve, dispute, arbitrate and redeem.
4. **An end-to-end NEAR Intents test** with a small real amount: SOL or ETH from another chain in, outcome tokens out.

## 12. Hackathon plan (2–14 Nov, submissions close Nov 14 23:59 UTC)

| Days | Work | Status |
|---|---|---|
| 2–4 | `OBMarket`, `OutcomeToken`, `OBMarketFactory`, and unit tests for sets | Done |
| 4–6 | `PFWAMarketHook` (bounds, trading window, fees), hook address mining with CREATE2 | Done |
| 6–8 | `MarketResolver` and `FeeCollector`. Fork test the full lifecycle | Done |
| 8–9 | Limit orders (`PFWALimitOrders`) wired to the hook. `IntentForwarder`, plus the 1Click flow and keeper | Done, run end to end on a fork |
| 9–11 | Front end (§10): create, market page, pay from any chain, disputes. Indexer and resolver bot changes | Front end done and run end to end on a local copy of Robinhood Chain (create, trade, limit orders, sets, liquidity in and out, disputes, redeem, pay from any chain with a live 1Click price). Indexer and resolver bot: to do |
| 11–12 | Deploy to mainnet with a per-market deposit cap, once every fee, cap and bond is confirmed. End-to-end tests with small amounts | Every setting confirmed Nov 8 (1% protocol fee, creator fee at most 1%, 1 USDG creation fee, 1,000 USDG cap per market, $PFWA held in the treasury). Buyback route checked. Deployed to mainnet Nov 9 from block 110,039,733 and verified on Sourcify |
| 12–13 | Demo video, README and build log | To do |
| 14 | Submit | To do |

**Launch safety:** a 1,000 USDG cap per market until the contracts are audited. No global cap (decided Nov 8).
