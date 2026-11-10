# PFWA order book markets: the app

The order book part of [pfwa.fun](https://pfwa.fun/book), as a standalone Next.js app. Everything it shows is read from the contracts in [`../orderbook`](../orderbook/README.md) on Robinhood Chain, and everything it does is a transaction the connected wallet signs. It needs no database and no keys.

| Page | What's on it |
|---|---|
| `/book` | Every market with its leading chance, USDG in play and time left |
| `/book/[id]` | Chart of each outcome's chance, trade history (cross-chain buys show the buyer, "via NEAR Intents"), holders, the order book for each outcome, rules stored onchain, oracle data, and the panels: Trade (market and limit orders; a market buy is split between the pool and full sets through `OBSetRouter` when that gets more tokens), Full sets (mint and redeem), Pay from any chain, Add liquidity, Resolution (post an outcome, dispute it with a bond, finalize, redeem) |
| `/book/create` | A custom market: question, outcomes, opening chances, rules, deadline, creator fee, and the creator's opening liquidity, locked in `LiquidityLocker` until trading stops |

## Run it

Node 20+.

```bash
npm ci
npm run build && npm start        # http://localhost:3000
# or: npm run dev
```

With no `.env.local` it reads the live mainnet contracts through Robinhood Chain's public RPC. Open [localhost:3000/book/200000](http://localhost:3000/book/200000) for a market with trades, limit orders and cross-chain buys. To trade, connect a browser wallet on Robinhood Chain (chain id 4663) holding USDG and a little ETH for gas. Optional settings are in [`.env.example`](.env.example).

### Pay from any chain

The panel works out of the box: it lists every chain and coin NEAR Intents' 1Click API supports, quotes the USDG and outcome tokens you'd get, and opens a deposit address for your order. The flow:

1. The server asks 1Click for a quote whose recipient is the order's own address on Robinhood Chain: `ForwarderFactory.depositAddress(order)`, a CREATE2 address computed from the buyer, market, outcome, minimum tokens, deadline and a nonce.
2. You send the coin from your wallet (EVM chains and Solana from the page; any other chain by sending to the deposit address).
3. 1Click swaps it and delivers USDG to the order's address.
4. Anyone can then call `execute(order)` (buys the outcome for the buyer) or, after the deadline, `refund(order)` (USDG back to the buyer). The page polls `/api/intents/order`, which does this with `INTENTS_KEEPER_PRIVATE_KEY` if set. Without a keeper, the progress window offers "Finish from your wallet" after 30 seconds.

Because the order is its own address, the server keeps nothing that matters: a forged order has no USDG behind it, and a paid order can only buy for its buyer or refund them. This app keeps open orders in memory; pfwa.fun also runs the keeper from a cron every minute, so closing the tab doesn't stop an order.

### Oracle data

Coin, football and DeFi markets are created on pfwa.fun, which stores each one's setup (the coin or match, the target, the deadline) in its database for its resolver. This app reads those setups and live readings from pfwa.fun's public API (`PFWA_API`) and shows them in the Oracle Data card and the resolve window. Custom markets (made on `/book/create`) have no oracle: their rules are onchain and the creator posts the outcome, open to dispute for 2 hours.

## On a local fork

To try everything with test funds, fork Robinhood Chain with [Foundry](https://getfoundry.sh)'s anvil and use one of anvil's accounts as a "Fork test wallet":

```bash
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8545

# in another terminal: give anvil account 0 some USDG from Uniswap's PoolManager, which holds plenty
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
PM=0x8366a39CC670B4001A1121B8F6A443A643e40951
ME=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
cast rpc anvil_impersonateAccount $PM --rpc-url http://127.0.0.1:8545
cast rpc anvil_setBalance $PM 0x8AC7230489E80000 --rpc-url http://127.0.0.1:8545
cast send $USDG "transfer(address,uint256)" $ME 500000000 --from $PM --unlocked --rpc-url http://127.0.0.1:8545
```

Then create `.env.local`:

```bash
ROBINHOOD_RPC_URL=http://127.0.0.1:8545
NEXT_PUBLIC_ROBINHOOD_RPC_URL=http://127.0.0.1:8545
NEXT_PUBLIC_OB_LOGS_RPC=http://127.0.0.1:8545
NEXT_PUBLIC_DEV_WALLET=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
NEXT_PUBLIC_OB_LIVE=0
INTENTS_LOCAL=1
```

and run `npm run dev`. Connect with "Fork test wallet" and every transaction goes to your fork: buy, sell, place and cancel limit orders, mint sets, create a market and seed its liquidity, post an outcome and dispute it. `INTENTS_LOCAL=1` makes Pay from any chain quote live prices without opening a real deposit address.

## Layout

- `src/lib/orderbook/`: reading markets (`read.ts`), the order book and your orders (`orders.ts`), price history and holders from swap and transfer logs (`history.ts`), limit order and price math (`math.ts`), buying through full sets (`splitBuy.ts`), Uniswap v4 swaps (`swap.ts`), liquidity (`liquidity.ts`), NEAR Intents (`intents.ts`, `intentsKeeper.ts`, `walletPay.ts`), ABIs and addresses (`abi.ts`, `config.ts`)
- `src/components/book/`: the panels
- `src/app/api/intents/`: the 1Click routes (token list, quote, order status and keeper, Solana transaction building, deposit notice)
- `src/app/api/market`, `src/app/api/oracle`: oracle data from pfwa.fun's public API
