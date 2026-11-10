import { parseAbi } from 'viem';

const POOL_KEY = 'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }';

export const obFactoryAbi = parseAbi([
  POOL_KEY,
  'struct MarketInfo { address market; address creator; bytes32 setupHash; string question; string rules; }',
  'struct CreateParams { bytes32 setupHash; string question; string rules; string[] outcomeNames; uint16[] openingBps; uint64 endOfTrading; uint16 creatorFeeBps; }',
  'function getMarket(uint256 marketId) view returns (MarketInfo)',
  'function getPools(uint256 marketId) view returns (PoolKey[])',
  'function nextMarketId() view returns (uint256)',
  'function creationFee() view returns (uint256)',
  'function defaultBond() view returns (uint256)',
  'function depositCap() view returns (uint256)',
  'function protocolFeeBps() view returns (uint16)',
  'function creationPaused() view returns (bool)',
  'function createMarket(CreateParams p) returns (uint256 marketId)',
  'event MarketCreated(uint256 indexed marketId, address indexed market, address indexed creator, bytes32 setupHash, string question, address[] outcomes, uint64 endOfTrading)',
  'event MarketRules(uint256 indexed marketId, string rules)',
  'error CreationIsPaused()',
  'error BadOutcomeCount()',
  'error BadOpeningPrices()',
  'error BadEndOfTrading()',
  'error FeeTooHigh()',
  'error BadRules()',
  'error UnknownMarket()',
]);

export const obMarketAbi = parseAbi([
  'function allOutcomes() view returns (address[])',
  'function endOfTrading() view returns (uint64)',
  'function depositCap() view returns (uint256)',
  'function halted() view returns (bool)',
  'function resolved() view returns (bool)',
  'function winningOutcome() view returns (uint8)',
  'function tradingOpen() view returns (bool)',
  'function mintSet(uint256 amount, address to)',
  'function burnSet(uint256 amount, address to)',
  'function redeem(uint8 outcome, uint256 amount, address to) returns (uint256 paid)',
  'error AlreadyResolved()',
  'error NotResolved()',
  'error BadOutcome()',
  'error ZeroAmount()',
  'error CapExceeded()',
]);

export const obResolverAbi = parseAbi([
  'function resolutions(uint256 marketId) view returns (address market, address creator, uint64 endOfTrading, uint64 disputeEnds, uint8 state, uint8 outcome, uint256 bond, address disputer)',
  'function mayResolve(uint256 marketId, address who) view returns (bool)',
  'function arbiter() view returns (address)',
  'function resolveMarket(uint256 marketId, uint8 outcome)',
  'function dispute(uint256 marketId)',
  'function finalize(uint256 marketId)',
  'function settleDispute(uint256 marketId, uint8 outcome)',
  'error WrongState()',
  'error NotAllowedToResolve()',
  'error DisputeWindowOver()',
  'error DisputeWindowOpen()',
  'error BadOutcome()',
  'error NotArbiter()',
]);

export const obHookAbi = parseAbi([
  'function pools(bytes32 poolId) view returns (address market, bool usdgIsCurrency0, int24 tickLower, int24 tickUpper, address creator, uint16 creatorFeeBps, uint16 protocolFeeBps, bool registered)',
  'function creatorFeesOwed(address creator) view returns (uint256)',
  'function claimCreatorFees(address to) returns (uint256 amount)',
  'error TradingClosed()',
  'error ExactOutputNotSupported()',
  'error PriceOutOfBounds(int24 tick, int24 tickLower, int24 tickUpper)',
]);

export const obLimitOrdersAbi = parseAbi([
  POOL_KEY,
  'function place(PoolKey key, int24 tickLower, bool zeroForOne, uint256 amountIn) returns (uint256 epoch)',
  'function cancel(PoolKey key, int24 tickLower, bool zeroForOne, address to) returns (uint256 amount0, uint256 amount1)',
  'function withdraw(uint256 epoch, address to) returns (uint256 amount0, uint256 amount1)',
  'function fill(PoolKey key, int24 tickLower, bool zeroForOne)',
  'function epochOf(bytes32 slot) view returns (uint256)',
  'function epochInfo(uint256 epoch) view returns (bool filled, uint128 liquidityTotal, uint256 token0Total, uint256 token1Total)',
  'function liquidityOf(uint256 epoch, address owner) view returns (uint128)',
  'event Placed(address indexed owner, uint256 indexed epoch, bytes32 indexed poolId, int24 tickLower, bool zeroForOne, uint128 liquidity, uint256 amountIn)',
  'event Filled(uint256 indexed epoch, bytes32 indexed poolId, int24 tickLower, bool zeroForOne, uint256 amount0, uint256 amount1)',
  'event Cancelled(address indexed owner, uint256 indexed epoch, uint256 amount0, uint256 amount1)',
  'event Withdrawn(address indexed owner, uint256 indexed epoch, uint256 amount0, uint256 amount1)',
  'error UnknownPool()',
  'error TradingClosed()',
  'error BadTick()',
  'error CrossedRange()',
  'error ZeroLiquidity()',
  'error NotFilled()',
  'error NothingToWithdraw()',
  'error NotCrossed()',
]);

export const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

export const v4QuoterAbi = parseAbi([
  POOL_KEY,
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);

export const permit2Abi = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
]);

export const universalRouterAbi = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);

export const poolManagerSwapEvent = parseAbi([
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
])[0];

/** Every ABI above, for decoding a revert from any of them. */
export const obErrorsAbi = [...obFactoryAbi, ...obMarketAbi, ...obResolverAbi, ...obHookAbi, ...obLimitOrdersAbi];

export const obLockerAbi = parseAbi([
  'struct Position { uint8 outcome; int24 tickLower; int24 tickUpper; uint256 liquidity; uint128 amount0Max; uint128 amount1Max; }',
  'function seed(uint256 marketId, uint256 sets, uint256 poolUsdg, Position[] positions) returns (uint256 firstTokenId)',
  'function release(uint256 marketId, address seeder)',
  'function lockedUsdg(uint256 marketId, address seeder) view returns (uint256)',
  'function totalLockedUsdg(uint256 marketId) view returns (uint256)',
  'function lockedPositions(uint256 marketId, address seeder) view returns (uint256[])',
  'event Locked(uint256 indexed marketId, address indexed seeder, uint256 firstTokenId, uint256 positions, uint256 usdgIn)',
  'event Released(uint256 indexed marketId, address indexed seeder, uint256[] tokenIds)',
  'error TradingNotOpen()',
  'error TradingStillOpen()',
  'error NothingLocked()',
  'error NoPositions()',
  'error BadOutcome()',
  'error ZeroAmount()',
]);
