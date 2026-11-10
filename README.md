# PFWA Contracts

The smart contracts that power **[pfwa.fun](https://pfwa.fun)**, an onchain prediction market protocol on **Robinhood Chain**. Its live markets trade on bonding curves; order book markets, where outcomes are backed 1:1 by USDG and trade in Uniswap v4 pools, are being built in [`orderbook/`](orderbook/).

Every market, trade, resolution and payout on pfwa.fun goes through these contracts. They have been live on Robinhood Chain mainnet since July 31, 2026, and **121 markets** have been created through them so far (see [Deployments](#deployments-robinhood-chain) and [Timeline](#timeline)).

- App: [pfwa.fun](https://pfwa.fun)
- Chain: Robinhood Chain (chainId `4663`), RPC `https://rpc.mainnet.chain.robinhood.com`

## Order book markets (new, built for the NEAR Hackathon, Nov 1–14 2026)

A second market engine, in [`orderbook/`](orderbook/). Each outcome is a token backed 1:1 by USDG, so its price is the market's chance (0.62 = 62%) and a winning token pays exactly 1 USDG. Each outcome trades in its own Uniswap v4 pool, all run by one PFWA hook. Markets have limit orders, store their rules onchain, resolve from the same data sources as the bonding curve markets plus a 2-hour dispute window, and can be bought into from any chain through NEAR Intents. The creator opens each market with its liquidity, which a `LiquidityLocker` holds until trading stops.

Product and technical docs: [`docs/prd-order-book-markets.md`](docs/prd-order-book-markets.md), [`docs/spec-order-book-markets.md`](docs/spec-order-book-markets.md).

### For judges: what to run and what you should see

Needs [Foundry](https://getfoundry.sh) and Node 20+.

```bash
git clone --recurse-submodules https://github.com/MirakoolDev/pfwa-contracts
cd pfwa-contracts/orderbook
forge test                       # 41 passed, 2 skipped (the fork tests, below)
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com   forge test --match-path test/OrderBookFork.t.sol   # 1 passed: a market's whole life on a copy of Robinhood Chain
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com   forge test --match-path test/LiquidityLockerFork.t.sol   # 1 passed: the deployed factory, seeded and locked, released after trading
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com   forge test --match-path test/OBSetRouterFork.t.sol      # 3 passed: buying through full sets on live market 200000 moves both prices and gets more than a plain buy
cd intents && npm install && npm test   # 9 passed: the NEAR Intents flow
node cli.mjs buy --from nep141:sol.omft.near --amount 0.1 --refund-to <a Solana address>   --user 0xYourRobinhoodAddress --market 200000 --outcome 0 --dry   # a live 1Click price, nothing spent
```

`bash e2e/fork.sh` (in `orderbook/intents`) runs the whole cross-chain buy on a local copy of Robinhood Chain with a live 1Click price. Our run: 0.1 SOL → 9.03 USDG delivered → 14.66 YES tokens in the buyer's wallet.

**The app, run locally.** [`frontend/`](frontend/README.md) is pfwa.fun's order book app on its own: it reads the live contracts, needs no database and no keys.

```bash
cd frontend && npm ci && npm run build && npm start   # http://localhost:3000
```

Open market 200000 (SPX) to see the chart, trade history, order book, oracle data and the Pay from any chain panel. Connect a wallet on Robinhood Chain to trade, place limit orders, mint sets or create a market with real USDG; or run it against a local fork with a test wallet ([`frontend/README.md`](frontend/README.md#on-a-local-fork)). It's also live at [pfwa.fun/book](https://pfwa.fun/book).

### What was built, and what existed before

| | |
|---|---|
| **Built during the hackathon** | `orderbook/`, `frontend/` and `docs/`. Full diff since the last pre-hackathon commit: [8f4ff32...main](https://github.com/MirakoolDev/pfwa-contracts/compare/8f4ff32...main) |
| **Existed before** | Everything outside `orderbook/`, `frontend/` and `docs/`: the bonding curve contracts in `src/`, live on Robinhood Chain since July 31, 2026 |
| **Contracts** | `OBMarketFactory`, `OBMarket`, `OutcomeToken`, `PFWAMarketHook` (Uniswap v4), `PFWALimitOrders`, `MarketResolver`, `FeeCollector`, `IntentForwarder` + `ForwarderFactory`, `LiquidityLocker` + `LiquidityLockerFactory`, `OBSetRouter` + `OBSetRouterFactory`. What each does: [`orderbook/README.md`](orderbook/README.md) |
| **NEAR integration** | [`orderbook/intents/`](orderbook/intents/README.md): pay with SOL, BTC, USDC on Base or any asset NEAR Intents supports, receive outcome tokens on Robinhood Chain through the 1Click API and our `ForwarderFactory`. Each order gets its own CREATE2 deposit address, so no database or custodian holds funds; the keeper can only buy for the trader or refund them. Winnings go back the same way |
| **App** | [`frontend/`](frontend/README.md): the market list, create page and market page (chart, trades, holders, limit orders, buying through sets, liquidity, disputes, redeem) and the Pay from any chain panel, as a standalone Next.js app. pfwa.fun runs the same code inside its main app |
| **Track** | Unstoppable DeFi: a market with no custodian, settled across chains through NEAR Intents |

### Launch settings and status

- **Creator liquidity (Nov 9):** a market on pfwa.fun opens with at least 100 USDG of the creator's liquidity, placed 20 points either side of each outcome's opening chance and locked in the `LiquidityLocker` until trading stops. The creator earns the creator fee on every trade. The 100 USDG minimum is pfwa.fun's rule; the lock is the contract's.
- **Settings (confirmed Nov 8):** 1% protocol fee (at most 2%), creator fee 0 to 1%, 1 USDG to create a market, 50 USDG dispute bond, 2-hour dispute window, at most 1,000 USDG per market until audited. Fees buy back $PFWA hourly through Uniswap V3 (USDG → WETH → the $PFWA Pons pool) and the $PFWA is held in the treasury. Every address: [`orderbook/README.md`](orderbook/README.md#launch-settings).
- **Live on Robinhood Chain mainnet (Nov 9, 2026, from block 110,039,733), every contract verified on Sourcify:**

| Contract | Address | Source |
|---|---|---|
| `OBMarketFactory` | [`0x06703aE0f85Ad14846CB5EeBCeBFc85b1cebB6F7`](https://robinhoodchain.blockscout.com/address/0x06703aE0f85Ad14846CB5EeBCeBFc85b1cebB6F7) | [Sourcify](https://repo.sourcify.dev/4663/0x06703aE0f85Ad14846CB5EeBCeBFc85b1cebB6F7) |
| `PFWAMarketHook` | [`0x2a4C4B54b096746Bdc328969dB02de7Cbca4A0Cc`](https://robinhoodchain.blockscout.com/address/0x2a4C4B54b096746Bdc328969dB02de7Cbca4A0Cc) | [Sourcify](https://repo.sourcify.dev/4663/0x2a4C4B54b096746Bdc328969dB02de7Cbca4A0Cc) |
| `PFWALimitOrders` | [`0x6e7E0265a6B8080E0b5233cF186818FC1Be22C2A`](https://robinhoodchain.blockscout.com/address/0x6e7E0265a6B8080E0b5233cF186818FC1Be22C2A) | [Sourcify](https://repo.sourcify.dev/4663/0x6e7E0265a6B8080E0b5233cF186818FC1Be22C2A) |
| `MarketResolver` | [`0x365C5301c42694478cC11b837C28449f7B5A08ae`](https://robinhoodchain.blockscout.com/address/0x365C5301c42694478cC11b837C28449f7B5A08ae) | [Sourcify](https://repo.sourcify.dev/4663/0x365C5301c42694478cC11b837C28449f7B5A08ae) |
| `FeeCollector` | [`0xacA8702af8B8344F646e06525C354d10747B55B9`](https://robinhoodchain.blockscout.com/address/0xacA8702af8B8344F646e06525C354d10747B55B9) | [Sourcify](https://repo.sourcify.dev/4663/0xacA8702af8B8344F646e06525C354d10747B55B9) |
| `ForwarderFactory` (NEAR Intents) | [`0xD95560b028F61eB5a28379bC5588DE315f2CcA38`](https://robinhoodchain.blockscout.com/address/0xD95560b028F61eB5a28379bC5588DE315f2CcA38) | [Sourcify](https://repo.sourcify.dev/4663/0xD95560b028F61eB5a28379bC5588DE315f2CcA38) |
| `LiquidityLocker` | [`0x5Bfc103f5b7d55c04BADb2F170b01dbCBc74aeca`](https://robinhoodchain.blockscout.com/address/0x5Bfc103f5b7d55c04BADb2F170b01dbCBc74aeca) | [Sourcify](https://repo.sourcify.dev/4663/0x5Bfc103f5b7d55c04BADb2F170b01dbCBc74aeca) |
| `LiquidityLockerFactory` | [`0x29823d36a74Fc163Bd07fF29F59E0579c675Ff96`](https://robinhoodchain.blockscout.com/address/0x29823d36a74Fc163Bd07fF29F59E0579c675Ff96) | [Sourcify](https://repo.sourcify.dev/4663/0x29823d36a74Fc163Bd07fF29F59E0579c675Ff96) |
| `OBSetRouter` | [`0x3f4aCb32c0141ff189C3e44c6a9333905F55Dd2F`](https://robinhoodchain.blockscout.com/address/0x3f4aCb32c0141ff189C3e44c6a9333905F55Dd2F) | [Sourcify](https://repo.sourcify.dev/4663/0x3f4aCb32c0141ff189C3e44c6a9333905F55Dd2F) |
| `OBSetRouterFactory` | [`0x5135c6B5e7efB468C31c9Bcb506A522d20B90c6e`](https://robinhoodchain.blockscout.com/address/0x5135c6B5e7efB468C31c9Bcb506A522d20B90c6e) | [Sourcify](https://repo.sourcify.dev/4663/0x5135c6B5e7efB468C31c9Bcb506A522d20B90c6e) |


## How it works (bonding curve markets)

The bonding curve engine has no order book and no counterparty matching. Each option in a market (e.g. `YES` / `NO`, or up to 10 choices) is its own ERC-20 token priced by a linear bonding curve. Buying an option mints tokens and adds ETH to that option's reserve; the price rises as more people buy it, so the relative prices of the options act as the market's implied probabilities.

When the market resolves, the ETH in every losing option's reserve is moved into the winning option, and each winning token becomes redeemable for a fixed amount of ETH.

```
            createMarket / createRelayerMarket
                          │
                          ▼
┌───────────────────────────────────────────────┐
│               PFWAMarketFactory               │
│  deploys one EIP-1167 clone per option        │
└───────┬───────────────┬───────────────┬───────┘
        ▼               ▼               ▼
  BondingCurveToken BondingCurveToken  ...      ← buy / sell on the curve
     "YES" (ETH)       "NO" (ETH)

resolveMarket(winner = YES)
  1. losing reserves (NO, ...) + bonus pot → YES reserve
  2. fixedRedemptionPrice = total pool / YES supply
  3. trading halts; YES holders call claimWinnings()
```

### 1. Market creation

- **`createMarket`** — anyone can open a market with 2–10 options by paying the creation fee (default `0.005 ETH`, capped at 100 user-created markets per day). Half the fee goes to the platform treasury; the other half buys back PFWA on a Uniswap V3-style router and sends it to the burn address.
- **`createRelayerMarket`** — fee-free creation for the protocol's trusted relayer (used for automated recurring markets).

Each option is deployed as a cheap [EIP-1167](https://eips.ethereum.org/EIPS/eip-1167) minimal-proxy clone of a single `BondingCurveToken` implementation.

### 2. Trading on the curve

Price is linear in supply:

```
spotPrice(supply) = basePrice + slope × supply
```

`costToBuy` / `proceedsFromSell` integrate this curve exactly, and `tokensForEth` solves the quadratic for the inverse. Defaults: `basePrice = slope = 0.00000003 ETH`.

| Action | Fee |
|---|---|
| Buy | 1.5% to the market creator + 1.5% to the platform |
| Sell **before** expiry | 10% early-exit penalty: half to the platform, half to the market's **bonus pot** (paid to winners) |
| Sell after expiry + grace period (if still unresolved) | 1.5% creator + 1.5% platform |

Trading runs until `expirationTime`, then **pauses for a grace period** (default 2 days) so the market can be resolved without last-second trades. If a market is still unresolved after the grace period, trading reopens so funds are never locked.

### 3. Resolution

`resolveMarket(marketId, winningIndex)` can be called by the market creator, by the owner, or by the relayer for protocol-created markets. After the grace period, the relayer/owner can resolve any market. Resolution:

1. Drains the ETH reserve of every losing option to the factory.
2. Adds the market's bonus pot (collected from early-exit penalties).
3. Sets `fixedRedemptionPrice = totalPool / winningSupply` on the winning token.
4. Marks every option token resolved, which permanently halts trading.

If nobody holds the winning option, the pool is sent to the platform treasury since there is no one to pay.

### 4. Claiming

Winners call `claimWinnings()` on the winning option token. It burns the caller's full balance and pays `balance × fixedRedemptionPrice`. Because the price is fixed at resolution, every winner is paid the same rate regardless of when they claim.

### Automated markets: the orchestrator

`PFWA.sol` is a relayer-controlled orchestrator that sits in front of the factory and runs recurring markets from off-chain data (Dune Analytics):

- **Daily checkpoints** — `createDailyCheckpoints` / `resolveDailyCheckpoints` open and settle a batch of markets per day (protocol fees, purchases, collection races, etc.).
- **Listing markets** — `createListingMarket` / `resolveListingMarket` open a binary "Keep NFT" vs "Take ETH" market for each FWA listing.

## Deployments (Robinhood Chain)

| Contract | Address | Markets |
|---|---|---|
| `PFWAMarketFactory` (V2, active) | [`0x7B38e940Cd649bc0C701c42eE1A6ceff75584afa`](https://robinhoodchain.blockscout.com/address/0x7B38e940Cd649bc0C701c42eE1A6ceff75584afa) | 29 |
| `PFWAMarketFactory` (V1, legacy markets) | [`0x2502aB7E69dDb3157683A82E603360Ada9B6E647`](https://robinhoodchain.blockscout.com/address/0x2502aB7E69dDb3157683A82E603360Ada9B6E647) | 92 |
| `PFWA` orchestrator | [`0x943F5d2E75afec6d3f75aaF2E7Cdf8fE5418eD33`](https://robinhoodchain.blockscout.com/address/0x943F5d2E75afec6d3f75aaF2E7Cdf8fE5418eD33) | — |
| `BondingCurveToken` implementation (V2) | [`0x913d53E2fc37F3B4a2B67eE7c089B827054455b8`](https://robinhoodchain.blockscout.com/address/0x913d53E2fc37F3B4a2B67eE7c089B827054455b8) | — |
| `BondingCurveToken` option tokens | one EIP-1167 clone per market option — read via `getOptionTokenAddresses(marketId)` | — |

Market counts are as of September 11, 2026 and can be checked by calling `marketCount()` on each factory.

### This repo is what's deployed

- The V2 factory's source is [verified on Blockscout](https://robinhoodchain.blockscout.com/address/0x7B38e940Cd649bc0C701c42eE1A6ceff75584afa?tab=contract). The `PFWAMarketFactory` and `BondingCurveToken` code in `src/` is identical to that verified source; only comment formatting differs, because the verified copy is a single flattened file.
- Built from this repo with `forge build`, both contracts produce **the same runtime bytecode as the live V2 factory and `BondingCurveToken` implementation** (15,609 and 10,641 bytes), ignoring only the compiler metadata hash and the factory's constructor-set immutables. You can reproduce this by comparing `out/<Contract>.sol/<Contract>.json` → `deployedBytecode` with `cast code <address> --rpc-url https://rpc.mainnet.chain.robinhood.com`.
- The `BondingCurveToken` implementation is verified against this repo's source on [Blockscout](https://robinhoodchain.blockscout.com/address/0x913d53E2fc37F3B4a2B67eE7c089B827054455b8?tab=contract) and [Sourcify](https://repo.sourcify.dev/4663/0x913d53E2fc37F3B4a2B67eE7c089B827054455b8) (partial match: the executable bytecode is identical; only the compiler's metadata hash differs).

## Timeline

PFWA was built over about six weeks inside the private pfwa.fun monorepo (frontend, relayer, indexer and these contracts; 128 commits since July 31). This repository is the public extraction of the contracts, which is why its own git history starts at a single commit. The onchain record below can be checked independently on [Blockscout](https://robinhoodchain.blockscout.com).

| Date (2026) | Milestone |
|---|---|
| Jul 28 | Contract development begins |
| Jul 31 | V1 factory live on Robinhood Chain; first market created |
| Aug 30 | Last market on V1 (92 in total) |
| Aug 31 | V2 factory deployed with fixes; first V2 market created |
| Sep 11 | 29 markets on V2 and counting; 121 across both factories |

## Contracts

| File | Description |
|---|---|
| [`src/PFWAMarketFactory.sol`](src/PFWAMarketFactory.sol) | Singleton factory: market creation, resolution, fee routing, PFWA buyback & burn, admin controls |
| [`src/BondingCurveToken.sol`](src/BondingCurveToken.sol) | Per-option ERC-20 with linear bonding curve, buy/sell, fixed-price redemption |
| [`src/PFWA.sol`](src/PFWA.sol) | Relayer orchestrator for daily checkpoint and listing markets |
| [`src/interfaces/IPFWAMarketFactory.sol`](src/interfaces/IPFWAMarketFactory.sol) | Minimal factory interface |
| [`src/PFWAMarkets.sol`](src/PFWAMarkets.sol) | Documentation only: catalogue of supported market designs and their data sources |
| [`script/`](script) | Foundry deployment scripts |

## Trust model

These contracts are not permissionless end-to-end. It's worth being explicit about what is trusted:

- **Resolution is oracle-based.** Outcomes are set by the market creator (for user markets) or the protocol relayer/owner (for automated markets), using public Dune data. Bonding curve markets have no onchain dispute mechanism; order book markets add a 2-hour dispute window with a 50 USDG bond, settled by the owner multisig.
- **Owner powers.** The factory owner can pause market creation, pause trading on a market, change the relayer, treasury, default curve and fee parameters, and recover stray ETH/ERC-20s. Per-market fees can only ever be **lowered** after creation.
- **Chain-specific config.** The PFWA token, DEX router and WETH addresses used for buyback & burn are set to Robinhood Chain defaults in `PFWAMarketFactory` and can be changed by the owner.

## Build

Requires [Foundry](https://getfoundry.sh).

```bash
git clone --recursive https://github.com/MirakoolDev/pfwa-contracts.git
cd pfwa-contracts
forge build
```

If you cloned without `--recursive`, run `git submodule update --init --recursive` first.

Dependencies (git submodules in `lib/`): OpenZeppelin Contracts and OpenZeppelin Contracts Upgradeable, both pinned to v5.6.1, plus forge-std. `foundry.toml` uses the same compiler settings as the verified V2 deployment: solc 0.8.36 with the optimizer on at 200 runs.

## Deploy

The scripts read configuration from environment variables:

| Variable | Used by | Description |
|---|---|---|
| `PRIVATE_KEY` | both | Deployer key |
| `PLATFORM_ADDRESS` | `DeployPFWAMarkets` | Treasury that receives platform fees |
| `RELAYER_ADDRESS` | both | Relayer wallet (off-chain cron) |
| `FACTORY_ADDRESS` | `DeployPFWAOrchestrator` | Factory deployed in step 1 |

```bash
# 1. Deploy the BondingCurveToken implementation + PFWAMarketFactory
forge script script/DeployPFWAMarkets.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast

# 2. Deploy the PFWA orchestrator and make it the factory's relayer
#    (must be run with the factory owner's key)
forge script script/DeployPFWAOrchestrator.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast
```

## License

MIT
