# PFWA order book markets

Contracts for PFWA's second market engine. Each outcome is a token backed 1:1 by USDG, traded in its own Uniswap v4 pool through one PFWA hook, and resolved the way PFWA's bonding curve markets are, plus a 2-hour dispute window with a bond. Product and design docs: `../docs/prd-order-book-markets.md` and `../docs/spec-order-book-markets.md`.

## Contracts

| File | Contract | Job |
|---|---|---|
| `src/OBMarketFactory.sol` | `OBMarketFactory` | Creates markets: clones the market and outcome tokens, opens one v4 pool per outcome at the creator's opening prices, registers the market with the resolver. Holds no user funds. |
| `src/OBMarket.sol` | `OBMarket` | Holds a market's USDG. Mints and burns complete sets (1 USDG ⇄ one of every outcome), and pays redemptions after resolution (1 USDG per winning token, or 1/N each if the market is invalid). |
| `src/OutcomeToken.sol` | `OutcomeToken` | ERC-20 with 6 decimals, like USDG. Only its market can mint or burn. |
| `src/PFWAMarketHook.sol` | `PFWAMarketHook` | The v4 hook. Only the factory can create pools. Swaps must be exact-input and only while the market is open. The fee is taken on the USDG leg, then held for creators to claim and swept to the fee collector. Prices must stay between 0.001 and 0.999 USDG. Reports each swap's price move to the limit-order book. |
| `src/MarketResolver.sol` | `MarketResolver` | Resolves exactly as PFWA's bonding curve markets do (`resolveMarket`: the creator, the relayer for platform markets, the owner, or the relayer or owner 24 hours after the deadline), which stops trading. The result is final after a 2-hour window unless someone disputes it with the market's bond (50 USDG); the owner multisig then settles it, and a disputer who was right gets the bond back. |
| `src/FeeCollector.sol` | `FeeCollector` | Receives protocol USDG and buys back $PFWA through a V3 path. Only the owner or keeper can trigger it, at most hourly, with a quoted minimum-out. It sends to the treasury, or burns if configured. |
| `src/PFWALimitOrders.sol` | `PFWALimitOrders` | Limit orders. An order is one-sided liquidity in one price step on the far side of the price; when a swap moves the price fully through it, it has filled. Orders at the same step share one position. Filled in the swap that crosses them (up to 8 a swap), or later by anyone with `fill`. Cancel any time, withdraw once filled. No owner, no fee. |
| `src/IntentForwarder.sol` | `ForwarderFactory`, `IntentDeposit` | NEAR Intents entry. Each cross-chain order gets a deterministic deposit address. Once USDG lands there, `execute` buys the outcome for the user (respecting `minOut`, and stopping at the price bound with the rest returned), and `refund` returns the USDG. The off-chain side (1Click quotes, the keeper, a CLI and an end-to-end fork run) is in [`intents/`](intents/README.md). |

### Choices to know about
- **No admin pausing.** Trading closes at the market's end of trading, or as soon as a result is posted (a data source can settle a market early, as on bonding curve markets), and never reopens. No admin can pause a market or change a live market's fees or bounds.
- **Fees are pulled, not pushed.** USDG can freeze addresses, so paying fees inside a swap would let a frozen creator address block a market. Creators call `claimCreatorFees` instead.
- **Exact-input swaps only.** That keeps the fee logic simple, and the Universal Router supports it.
- **Limit orders are our own** (`PFWALimitOrders`): the hook reports every swap's price move to it, and it fills the price steps the swap crossed.

## Setup

Uniswap v4 is a git submodule pinned to `c6e4754`. From the repository root:

```bash
git submodule update --init --recursive
```

## Test

Either runner works with the same `test/*.t.sol` files:

```bash
forge test            # Foundry
npm install && npm test   # Hardhat 3 (Solidity tests)
```

`test/OrderBook.t.sol` covers:
- opening prices
- set mint and burn
- buy and sell fees
- claimed creator fees
- price bounds
- trading closed after end of trading
- exact-output rejection
- pools only creatable by the factory
- resolution as on bonding curve markets: who may resolve, trading stopping on a result (also before the deadline), the 2-hour window, finalize and redemption
- disputes: only on a pending result, once, inside the window; a disputer who was right gets the bond back, one who was wrong loses it to the fee collector
- invalid markets
- buybacks, including the keeper restriction
- cross-chain execute and refund, and a big cross-chain order stopping at the price bound with the rest returned
- the owner can hand dispute settlement to another arbiter (a $PFWA holder vote later) and nothing else
- only the named deployer sets up the hook (it's deployed through the CREATE2 deployer)
- limit orders: sells filled by a buy and buys filled by a sell crossing them, cancels (also after the market closes), orders at one price sharing the fill pro rata, the per-swap cap with anyone filling the rest, placement rules (far side, on the spacing, inside the bounds, trading open), only the hook reporting moves; fuzz: makers always get their share and the book stays solvent
- the per-market deposit cap, and implementations that can't be initialised
- a market's rules are stored with it, and a market needs rules of 1 to 2,000 bytes
- fuzz: fees never exceed the configured rate; random buys, sells, mints and burns never touch a market's collateral (every outcome stays backed 1:1) and the hook holds exactly the fees it owes

`test/OrderBookFork.t.sol` runs the whole lifecycle on a Robinhood Chain fork, against Uniswap's deployed PoolManager and the real USDG: create a capped market, seed both pools, buy through the PoolManager, propose, wait out the window, finalize and redeem. It's skipped unless `ROBINHOOD_RPC_URL` is set:

```bash
ROBINHOOD_RPC_URL=<rpc> forge test --match-contract OrderBookForkTest
```

41 tests, all passing (40 local, 1 fork).

**Price bounds and routers:** a swap that would push an outcome past 0.001 or 0.999 USDG reverts. Front ends and the forwarder should set `sqrtPriceLimitX96` at the pool's bound so a big order stops there instead of failing.

## Deploy

```bash
forge script script/Deploy.s.sol --rpc-url robinhood --broadcast
```

The required environment variables are listed at the top of the script. The hook's address is mined with CREATE2 so it carries its permission bits.

## Before mainnet
- USDG confirmed onchain: `0x5fc5…d168` is Global Dollar, 6 decimals, and 1Click lists it on `hood`.
- Set the launch deposit cap: `DEPOSIT_CAP` in the deploy script (per market; the owner can change it for new markets with `setDepositCap`).
- Get an audit.
