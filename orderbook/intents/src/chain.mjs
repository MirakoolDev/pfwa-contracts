// Robinhood Chain side: the order the ForwarderFactory executes, its deposit address, and the outcome a USDG
// amount buys right now (Uniswap's V4 Quoter, through the PFWA hook, so the market's fee is included).
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
});

export const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const V4_QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94';

const POOL_KEY = 'address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks';
const ORDER = 'address user; uint256 marketId; uint8 outcome; uint256 minOut; uint64 deadline; uint256 nonce';

export const forwarderAbi = parseAbi([
  `struct Order { ${ORDER}; }`,
  'function depositAddress(Order o) view returns (address)',
  'function execute(Order o) returns (uint256 tokensOut)',
  'function refund(Order o)',
  'event Executed(address indexed deposit, address indexed user, uint256 indexed marketId, uint8 outcome, uint256 usdgIn, uint256 tokensOut)',
  'event Refunded(address indexed deposit, address indexed user, uint256 amount)',
  'error Expired()',
  'error NothingDeposited()',
  'error NotYet()',
  'error InsufficientOutput(uint256 out, uint256 minOut)',
]);
export const factoryAbi = parseAbi([
  `struct PoolKey { ${POOL_KEY}; }`,
  'function getPools(uint256 marketId) view returns (PoolKey[])',
]);
export const quoterAbi = parseAbi([
  `struct PoolKey { ${POOL_KEY}; }`,
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);
export const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)']);

export function clients({ rpcUrl = process.env.ROBINHOOD_RPC_URL, keeperKey = process.env.KEEPER_PRIVATE_KEY } = {}) {
  const transport = http(rpcUrl || robinhood.rpcUrls.default.http[0]);
  const publicClient = createPublicClient({ chain: robinhood, transport });
  const walletClient = keeperKey
    ? createWalletClient({ chain: robinhood, transport, account: privateKeyToAccount(keeperKey) })
    : null;
  return { publicClient, walletClient };
}

/** The order as the contract hashes it (field order matters: it's the deposit address's salt). */
export function makeOrder({ user, marketId, outcome, minOut, deadline, nonce }) {
  return {
    user,
    marketId: BigInt(marketId),
    outcome: Number(outcome),
    minOut: BigInt(minOut),
    deadline: BigInt(deadline),
    nonce: BigInt(nonce),
  };
}

/** A random 64-bit nonce, so a user's identical orders get distinct deposit addresses. */
export function randomNonce() {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  return BigInt(`0x${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`);
}

export async function depositAddressOf(publicClient, forwarder, order) {
  return publicClient.readContract({ address: forwarder, abi: forwarderAbi, functionName: 'depositAddress', args: [order] });
}

/** Outcome tokens `usdgIn` buys now on market `marketId`'s outcome pool, after the market's fee. */
export async function quoteOutcome(publicClient, { factory, marketId, outcome, usdgIn, quoter = V4_QUOTER }) {
  const pools = await publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'getPools', args: [BigInt(marketId)] });
  const key = pools[Number(outcome)];
  if (!key) throw new Error(`Market ${marketId} has no outcome ${outcome}`);
  const zeroForOne = key.currency0.toLowerCase() === USDG.toLowerCase();
  const { result } = await publicClient.simulateContract({
    address: quoter,
    abi: quoterAbi,
    functionName: 'quoteExactInputSingle',
    args: [{ poolKey: key, zeroForOne, exactAmount: BigInt(usdgIn), hookData: '0x' }],
  });
  return result[0];
}

export function applySlippage(amount, slippageBps) {
  return (BigInt(amount) * BigInt(10_000 - slippageBps)) / 10_000n;
}

export async function usdgBalance(publicClient, who) {
  return publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
}
