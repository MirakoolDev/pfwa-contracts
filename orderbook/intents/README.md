# pfwa-intents: trade PFWA order book markets from any chain

Built for the NEAR Hackathon (Nov 1–14, 2026). This is the NEAR integration of PFWA's order book markets: a trader pays with an asset on another chain (SOL on Solana, USDC on Base, BTC, …) and receives outcome tokens of a market on Robinhood Chain, in one step, through NEAR Intents' 1Click API. Winnings go back the same way.

## The problem it solves

PFWA's markets live on Robinhood Chain, and its outcomes are priced in USDG there. Without this, a trader holding SOL or USDC elsewhere has to bridge, swap into USDG and only then trade: three apps and several transactions. With it they send one transfer on the chain they already use.

## How a cross-chain buy works

1. **Price.** A dry 1Click quote prices the trader's asset in USDG on Robinhood Chain (`nep141:hood-0x5fc5…d168.omft.near`).
2. **Fix the order.** Uniswap's V4 Quoter prices that USDG in the outcome token, through the PFWA hook so the market's fee is included. Minus slippage, that is the order's `minOut`. The order (`user, marketId, outcome, minOut, deadline, nonce`) fixes a one-time deposit address on Robinhood Chain: `ForwarderFactory.depositAddress(order)`, a CREATE2 address in [`../src/IntentForwarder.sol`](../src/IntentForwarder.sol).
3. **Open the swap.** A live 1Click quote delivers USDG to that address and refunds to the trader's own address on their chain. The trader sends their asset to the deposit address 1Click gives (on their chain).
4. **Deliver.** NEAR Intents' solvers swap it and send USDG to the order's Robinhood address, in about 20–40 seconds.
5. **Execute.** The keeper sees the USDG and calls `ForwarderFactory.execute(order)`: it buys the outcome with all of it and sends the tokens to the trader. If the price moved past `minOut` it keeps trying until the deadline, then refunds the USDG to the trader on Robinhood Chain. The trader can also refund themselves at any time, and anyone can after the deadline.

**Withdraw to any chain:** a 1Click quote from USDG on Robinhood Chain to the asset the trader wants; they send the USDG to the deposit address it returns.

## Try it

Needs Node 20+. From `orderbook/intents`:

```bash
npm install
node cli.mjs help
```

Price a buy and a withdrawal against the live 1Click API (nothing is opened, nothing is spent):

```bash
node cli.mjs buy --from nep141:sol.omft.near --amount 0.1 --refund-to <a Solana address> \
  --user 0xYourRobinhoodAddress --market 200000 --outcome 0 --dry
node cli.mjs withdraw --to nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near --amount 10 \
  --recipient 0xYourBaseAddress --refund-to 0xYourRobinhoodAddress --dry
node cli.mjs tokens --chain hood
```

The buy prints something like this (until the contracts are deployed and `OB_FACTORY` is set, it prices the USDG leg only):

```json
{
  "pay": "0.1 SOL on sol",
  "usdgOnRobinhood": "~9.119166 (at least 9.027974)",
  "secondsToDeliver": 21,
  "dry": true,
  "note": "Set OB_FACTORY to price the outcome, and OB_FORWARDER to open the order."
}
```

### The whole flow, end to end, on a fork

Needs Foundry (`anvil`, `forge`, `cast`) too. `e2e/fork.sh` runs every step on a local fork of Robinhood Chain:

1. It deploys the order book contracts and opens a seeded market (`../script/DemoFork.s.sol`).
2. It runs `buy --local`: a live 1Click price for 0.1 SOL, and the order's deposit address on the fork.
3. It stands in for NEAR Intents' delivery by sending the quoted USDG to that address, on the fork only.
4. The keeper executes the order.

Expected output ends with:

```
== keeper pass
<order id>: execute done 0x…
== the user now holds 14662262 YES units (6 decimals)
OK
```

```bash
bash e2e/fork.sh
```

`--local` never opens a real 1Click deposit address: one aimed at an address that exists only on a fork would lose real funds.

### Live on Robinhood Chain

Once the contracts are deployed, set `OB_FACTORY` and `OB_FORWARDER` (see `.env.example`) and drop `--dry`. `buy` then prints the deposit address to pay on your chain and saves the order. Run the keeper with a funded `KEEPER_PRIVATE_KEY` (it only pays gas):

```bash
node cli.mjs keeper --watch 15
node cli.mjs status --deposit <the deposit address>
```

## Tests

```bash
npm test
```

There are 9 tests:
- the quote requests: USDG on Robinhood Chain as the destination, the order's deposit address as the recipient, refunds on the origin chain
- amounts in base units
- the partner key header, and API errors
- planning a buy: `minOut` from the onchain quote minus slippage, and the second quote aimed at the deposit address
- the dry and local modes
- every keeper decision: execute once USDG lands, refund after the deadline, wait while 1Click is still working, done once the deposit was used
- a keeper pass that executes an order and records it

The contract side (`execute`, `refund`, a big order stopping at the price bound) is tested in `../test/OrderBook.t.sol`.

## Files

| File | What it does |
|---|---|
| `src/oneclick.mjs` | 1Click client: tokens, quote, deposit submit, status; quote requests for buys and withdrawals; base-unit maths |
| `src/chain.mjs` | Robinhood Chain: the order struct, its deposit address, outcome quotes through the V4 Quoter, USDG balances |
| `src/flows.mjs` | `planBuy`, `planWithdraw`, the keeper's `decide` and `keeperPass` |
| `src/store.mjs` | The orders the keeper watches, in a JSON file |
| `cli.mjs` | The command line |
| `e2e/fork.sh` | The end-to-end run on a fork |

## Notes

- **Partner key:** optional. Without `ONECLICK_API_KEY` every quote carries an extra 0.25% platform fee. Partner keys come from [partners.near-intents.org](https://partners.near-intents.org).
- **Libraries:** [viem](https://viem.sh) for Robinhood Chain, Node's built-in test runner. No other dependencies.
- **Trust:** the keeper can only call `execute` (which pays the order's own trader, at or above `minOut`) or `refund` (which pays the trader). It never holds funds.
