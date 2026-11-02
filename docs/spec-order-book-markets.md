# Spec: Order book markets

**Status:** draft for the Solidity dev · first implementation in `orderbook/` · **Product doc:** `docs/prd-order-book-markets.md`
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
| `IntentForwarder` and `ForwarderFactory` | NEAR Intents entry: one-time deposit addresses that execute a trade (see §8). |

Use Foundry. Clone pattern as in the existing factory.

## 3. Markets and complete sets

```solidity
struct MarketConfig {
    bytes32 setupHash;        // same setup fingerprint as bonding curve markets
    uint64  endOfTrading;     // trading closes for good at this time, and proposals open
    uint8   outcomeCount;     // 2..10
    address creator;
    uint16  creatorFeeBps;    // e.g. 100 = 1%
    uint16  protocolFeeBps;   // e.g. 100 = 1%
}

// OBMarket
function mintSet(uint256 amount, address to) external;    // pull `amount` USDG, mint `amount` of every outcome
function burnSet(uint256 amount, address to) external;    // burn `amount` of every outcome, return `amount` USDG (before resolution)
function redeem(uint256 amount, address to) external;     // after resolution: burn winning tokens, pay 1 USDG each
```

**Invariant:** `USDG.balanceOf(market) == totalSupply(any outcome)` before resolution, and `>= totalSupply(winner) - redeemed` after it. Fuzz-test this.

- **Market IDs** start at `200000` so they never collide with the bonding curve factories.
- **Creation fee:** a flat USDG amount, sent to `FeeCollector`.

## 4. Pools

For each outcome `i`:
- **Pool key:** `{currency0, currency1} = sort(OUTCOME_i, USDG)`, `fee = 0` (the hook charges the fee), `tickSpacing = 10`, `hooks = PFWAMarketHook`.
- **Initial price:** set from the creator's opening probability. The default is an even 1/N.
- **Seeding:** the creator can provide liquidity by minting complete sets and adding concentrated liquidity between the price bounds. The factory exposes `createAndSeed`.

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
Pending ──dispute() + bond──▶ Disputed ──settleDispute(outcome), by the owner──▶ Final
```

**Who resolves:** the same rule as `PFWAMarketFactory.resolveMarket`: the market's creator, the relayer (the resolver bot reading the market's data source) for platform markets, the owner, and the relayer or owner once the market is 24 hours past its end of trading. A data source can settle a market before its deadline (instant results), and posting a result stops trading at once.

**Disputes:** for 2 hours after a result is posted, anyone can dispute it by posting the market's bond (50 USDG by default, set per market at creation). The owner (the PFWA multisig) then confirms or corrects the result. A disputer who was right gets the bond back; one who was wrong loses it to `FeeCollector`. No dispute: anyone calls `finalize()` when the window ends.

**`INVALID` outcome:** every outcome token redeems for `1/N` USDG, rounded down so the total paid never exceeds the market's balance.

**After finalising:** the resolver calls `OBMarket.finalize(outcome)`, which enables `redeem`.

## 8. NEAR Intents (cross-chain trading)

NEAR Intents' 1Click API lists Robinhood Chain as `hood`, with ETH, WETH and USDG.

**Buy from another chain**
1. **The front end asks the backend** for a forwarder address for `(user, marketId, outcome, minOut, deadline)`. `ForwarderFactory.predict()` computes it with CREATE2.
2. **The backend gets a quote** from `POST /v0/quote`:
   - origin asset: the user's choice
   - destination asset: `nep141:hood-0x5fc5…d168.omft.near` (USDG on Robinhood Chain)
   - recipient: the forwarder address
3. **The user sends funds** to the 1Click deposit address on their own chain.
4. **The backend tracks the swap.** It calls `POST /v0/deposit/submit`, then polls `GET /v0/status` until the status is `SUCCESS`.
5. **A keeper executes.** It calls `ForwarderFactory.deployAndExecute(...)`, which deploys the forwarder, swaps its USDG into the outcome through the Universal Router (respecting `minOut`) and sends the outcome tokens to the user's Robinhood Chain address.
6. **If execution fails** (price beyond `minOut`, or the deadline has passed), the user can call `refund()` on the forwarder to receive the USDG. The UI then offers a withdraw back to the original chain through 1Click.

**Withdraw to another chain**
1. The user redeems or sells for USDG.
2. They get a 1Click quote with origin USDG on `hood` and their chosen destination asset.
3. They send the USDG to the deposit address from their wallet.

**Notes**
- Get a partner key from partners.near-intents.org and use it for every quote; it may remove the 0.2% fee.
- Each user's Robinhood Chain address is their connected EVM wallet. Users without one are prompted to connect or create one.

## 9. FeeCollector and the $PFWA buyback

- **Fees in:** protocol swap fees, creation fees and slashed-bond shares, all in USDG.
- **`buyback(minOut)`:**
  1. Only the owner or the keeper can call it, at most once an hour. If anyone could call it, they could pass a `minOut` of 0 and sandwich the swap.
  2. It swaps the accumulated USDG into WETH, then WETH into $PFWA, through the existing $PFWA pool route, with `minOut` from a TWAP check or a keeper quote.
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

**Front end**
- The engine choice in `/create`.
- An order book market page, with the price chart from the pool tick history.
- A trade panel, with limit orders if they ship.
- The deposit-from-any-chain modal (§8).
- A dispute banner and button during the challenge window.

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

## 12. Hackathon plan (2–14 Nov)

| Days | Work |
|---|---|
| 2–4 | `OBMarket`, `OutcomeToken`, `OBMarketFactory`, and unit tests for sets |
| 4–6 | `PFWAMarketHook` (permissions, bounds, trading window, fees), plus hook address mining with CREATE2 to get the permission bits |
| 6–8 | `MarketResolver` and `FeeCollector`. Fork test the full lifecycle |
| 8–9 | Limit orders (`PFWALimitOrders`) wired to the hook. `IntentForwarder`, plus the backend 1Click flow |
| 9–11 | Front end: create, market page, deposit from any chain, disputes. Indexer and resolver bot changes |
| 11–12 | Deploy to mainnet with a per-market deposit cap. End-to-end tests with small amounts |
| 12–13 | Demo video, README and build log |
| 14 | Submit |

**Launch safety:** a per-market cap (e.g. 1,000 USDG) and a global cap until the contracts are audited.
