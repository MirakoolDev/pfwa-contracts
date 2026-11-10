// Order book markets: outcome tokens backed 1:1 by USDG, each trading in its own Uniswap v4 pool through the PFWA
// hook, with our own limit orders and a 2-hour dispute window (contracts: MirakoolDev/pfwa-contracts, orderbook/).
// Defaults to the live mainnet deployment.
import type { Address } from 'viem';
import { BROWSER_RPC_URL } from '@/lib/config';

const addr = (v: string | undefined): Address | undefined => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined);

/** The live deployment on Robinhood Chain mainnet (pfwa-contracts README). Each can be overridden with its env var, e.g.
 * to point at a local fork with your own deployment. */
const MAINNET = {
  factory: '0x06703aE0f85Ad14846CB5EeBCeBFc85b1cebB6F7',
  resolver: '0x365C5301c42694478cC11b837C28449f7B5A08ae',
  limitOrders: '0x6e7E0265a6B8080E0b5233cF186818FC1Be22C2A',
  forwarder: '0xD95560b028F61eB5a28379bC5588DE315f2CcA38',
  locker: '0x5Bfc103f5b7d55c04BADb2F170b01dbCBc74aeca',
  setRouter: '0x3f4aCb32c0141ff189C3e44c6a9333905F55Dd2F',
} as const;

export const OB = {
  factory: addr(process.env.NEXT_PUBLIC_OB_FACTORY || MAINNET.factory),
  resolver: addr(process.env.NEXT_PUBLIC_OB_RESOLVER || MAINNET.resolver),
  limitOrders: addr(process.env.NEXT_PUBLIC_OB_LIMIT_ORDERS || MAINNET.limitOrders),
  /** IntentForwarder factory: pay from any chain through NEAR Intents. */
  forwarder: addr(process.env.NEXT_PUBLIC_OB_FORWARDER || MAINNET.forwarder),
  /** LiquidityLocker: creator liquidity, locked while the market trades. */
  locker: addr(process.env.NEXT_PUBLIC_OB_LOCKER || MAINNET.locker),
  /** OBSetRouter: buys through full sets as well as the pool. */
  setRouter: addr(process.env.NEXT_PUBLIC_OB_SET_ROUTER || MAINNET.setRouter),
  /** The block the stack was deployed in: event scans start here. */
  deployBlock: BigInt(process.env.NEXT_PUBLIC_OB_DEPLOY_BLOCK || '110039733'),
};

/**
 * The RPC the browser reads order book events from. Event scans span many blocks, and the browser's usual RPC (an
 * Alchemy free key) only allows eth_getLogs over 10 blocks, so scans use Robinhood Chain's public RPC instead.
 * A local RPC (a fork) is used as it is.
 */
export const OB_LOGS_RPC = process.env.NEXT_PUBLIC_OB_LOGS_RPC || (/alchemy/i.test(BROWSER_RPC_URL) ? 'https://rpc.mainnet.chain.robinhood.com' : BROWSER_RPC_URL);

export const OB_ENABLED = Boolean(OB.factory && OB.resolver && OB.limitOrders);
/** NEXT_PUBLIC_OB_LIVE=0 marks every order book page as a preview (for a test deployment). */
export const OB_PREVIEW = process.env.NEXT_PUBLIC_OB_LIVE === '0';

// Robinhood Chain infrastructure.
export const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const UNIVERSAL_ROUTER: Address = '0x8876789976decbfcbbbe364623c63652db8c0904';
export const POOL_MANAGER: Address = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
export const POSITION_MANAGER: Address = '0x58daec3116aae6d93017baaea7749052e8a04fa7';
export const V4_QUOTER: Address = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94';
export const STATE_VIEW: Address = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** USDG and outcome tokens both have 6 decimals: 1 outcome token pays 1 USDG if it wins. */
export const DECIMALS = 6;
/** OBMarket.INVALID: every outcome redeems for 1/N. */
export const INVALID_OUTCOME = 255;
export const TICK_SPACING = 10;
/** Outcome prices stay between these (OBMarketFactory.MIN_PRICE_BPS / MAX_PRICE_BPS). */
export const MIN_PRICE = 0.001;
export const MAX_PRICE = 0.999;
export const FIRST_MARKET_ID = 200_000;
