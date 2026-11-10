import { defineChain } from 'viem';

/** Robinhood Chain's public RPC. Override with ROBINHOOD_RPC_URL (server) or NEXT_PUBLIC_ROBINHOOD_RPC_URL (browser). */
export const PUBLIC_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
/** RPC for API routes: never sent to the browser. */
export const SERVER_RPC_URL = process.env.ROBINHOOD_RPC_URL || PUBLIC_RPC_URL;
/** RPC for the browser. */
export const BROWSER_RPC_URL = process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL || PUBLIC_RPC_URL;

/** Robinhood Chain (chain id 4663). */
export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [typeof window === 'undefined' ? SERVER_RPC_URL : BROWSER_RPC_URL] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
});

export const TARGET_CHAIN_ID = 4663;
