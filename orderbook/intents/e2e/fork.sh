#!/usr/bin/env bash
# End to end on a local fork of Robinhood Chain, with the real NEAR Intents 1Click API:
#   1. deploy the order book stack and open a seeded market (script/DemoFork.s.sol)
#   2. `cli.mjs buy --local`: a live 1Click price for 0.1 SOL and the order's Robinhood deposit address on the fork
#      (--local opens no real 1Click deposit address: one aimed at a fork-only address would lose real funds)
#   3. stand in for NEAR Intents' delivery: send the quoted USDG to that deposit address (on the fork only)
#   4. `cli.mjs keeper`: the keeper executes the order and the user receives YES tokens
# Nothing is sent on a real chain and no SOL is spent: step 3 replaces the cross-chain swap.
# Needs foundry (anvil, forge, cast) and node 20+. Run from orderbook/intents: bash e2e/fork.sh
set -euo pipefail

UPSTREAM="${ROBINHOOD_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
PORT="${PORT:-8599}"
LOCAL="http://127.0.0.1:${PORT}"
PM=0x8366a39CC670B4001A1121B8F6A443A643e40951
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
# anvil's well-known test accounts (local only)
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
KEEPER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
KEEPER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
USER=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
SOL_REFUND=So11111111111111111111111111111111111111112

here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
anvil --fork-url "$UPSTREAM" --port "$PORT" --silent &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do cast block-number --rpc-url "$LOCAL" >/dev/null 2>&1 && break; sleep 1; done

echo "== lend the deployer 200,000 USDG from the PoolManager (fork only)"
cast rpc anvil_impersonateAccount "$PM" --rpc-url "$LOCAL" >/dev/null
cast rpc anvil_setBalance "$PM" 0x56BC75E2D63100000 --rpc-url "$LOCAL" >/dev/null
cast send "$USDG" "transfer(address,uint256)" "$DEPLOYER" 200000000000 --from "$PM" --unlocked --rpc-url "$LOCAL" >/dev/null

echo "== deploy the stack and open a seeded market"
(cd "$here/.." && PRIVATE_KEY=$DEPLOYER_KEY KEEPER=$KEEPER forge script script/DemoFork.s.sol --rpc-url "$LOCAL" --broadcast --slow) > "$work/deploy.log" 2>&1 || { cat "$work/deploy.log"; exit 1; }
val() { grep -E "^\s*$1 " "$work/deploy.log" | awk '{print $2}' | tail -1; }
export OB_FACTORY="$(val FACTORY)" OB_FORWARDER="$(val FORWARDER)"
MARKET_ID="$(val MARKET_ID)"
YES="$(val YES_TOKEN)"
echo "   factory $OB_FACTORY, forwarder $OB_FORWARDER, market $MARKET_ID"

export ROBINHOOD_RPC_URL="$LOCAL" KEEPER_PRIVATE_KEY="$KEEPER_KEY" INTENTS_STORE="$work/orders.json"
cd "$here"

echo "== buy YES with 0.1 SOL: live 1Click price, order fixed on the fork (--local: no real deposit address is opened)"
node cli.mjs buy --from nep141:sol.omft.near --amount 0.1 --refund-to "$SOL_REFUND" --user "$USER" --market "$MARKET_ID" --outcome 0 --local | tee "$work/buy.json"
DEPOSIT="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).robinhoodDepositAddress)" "$work/buy.json")"
USDG_MIN="$(node -e "const o=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const m=o.usdgOnRobinhood.match(/at least ([0-9.]+)/)[1];console.log(Math.round(Number(m)*1e6))" "$work/buy.json")"

echo "== stand in for NEAR Intents: deliver $USDG_MIN USDG units to $DEPOSIT (fork only)"
cast send "$USDG" "transfer(address,uint256)" "$DEPOSIT" "$USDG_MIN" --from "$PM" --unlocked --rpc-url "$LOCAL" >/dev/null

echo "== keeper pass"
node cli.mjs keeper

BAL="$(cast call "$YES" "balanceOf(address)(uint256)" "$USER" --rpc-url "$LOCAL" | awk '{print $1}')"
echo "== the user now holds $BAL YES units (6 decimals)"
[ "$BAL" != "0" ] || { echo "FAILED: no YES tokens"; exit 1; }
echo "OK"
