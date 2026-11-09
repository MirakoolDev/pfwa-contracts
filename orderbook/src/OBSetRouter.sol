// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {OBMarketFactory} from "./OBMarketFactory.sol";
import {OBMarket} from "./OBMarket.sol";
import {OutcomeToken} from "./OutcomeToken.sol";
import {PFWAMarketHook} from "./PFWAMarketHook.sol";

/// @title OBSetRouter
/// @notice Buys an outcome of an order book market in one transaction, two ways at once:
///  - direct: `usdgDirect` USDG buys the outcome in its own pool (its price goes up);
///  - through sets: mint `sets` full sets, sell every other outcome into its pool (their prices go down) and keep
///    `sets` of the outcome. The other outcomes' sales pay for most of the sets.
/// Each outcome trades in its own pool, so a direct buy alone moves only the bought outcome's price. The app splits
/// a buy between the two so the buyer gets the most tokens, which also keeps the outcomes' prices adding up to ~1.
///
/// Uses v4 flash accounting: the other outcomes are sold to the PoolManager before they exist, the USDG from the
/// sales (plus the buyer's) mints the sets, and the minted tokens then settle what the sales owe.
///
/// No owner, no fee of its own (the pools' usual fees apply to every swap), holds nothing between calls.
contract OBSetRouter is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable poolManager;
    OBMarketFactory public immutable marketFactory;
    IERC20 public immutable usdg;

    struct Buy {
        OBMarket market;
        PoolKey[] keys;
        uint8 outcome;
        uint256 sets;
        uint256 usdgDirect;
        uint256 usdgIn;
    }

    event Bought(address indexed buyer, uint256 indexed marketId, uint8 outcome, uint256 sets, uint256 usdgDirect, uint256 usdgPaid, uint256 tokensOut);

    error NotPoolManager();
    error BadOutcome();
    error ZeroAmount();
    /// The swaps came out worse than quoted, so `maxUsdgIn` doesn't cover the buy. Quote again.
    error NotEnoughUsdg(uint256 have, uint256 need);
    error InsufficientOutput(uint256 out, uint256 minOut);

    constructor(IPoolManager poolManager_, OBMarketFactory marketFactory_, IERC20 usdg_) {
        poolManager = poolManager_;
        marketFactory = marketFactory_;
        usdg = usdg_;
    }

    /// @notice Buy `outcome` in market `marketId`: `usdgDirect` USDG straight into its pool plus `sets` full sets
    /// whose other outcomes are sold. Pulls `maxUsdgIn` USDG from the caller and returns what's unused. Sends `to`
    /// at least `minOut` of the outcome, plus any other-outcome tokens a sale couldn't sell at a pool's price floor.
    function buy(uint256 marketId, uint8 outcome, uint256 sets, uint256 usdgDirect, uint256 maxUsdgIn, uint256 minOut, address to)
        external
        nonReentrant
        returns (uint256 tokensOut, uint256 usdgPaid)
    {
        if ((sets == 0 && usdgDirect == 0) || maxUsdgIn == 0) revert ZeroAmount();
        PoolKey[] memory keys = marketFactory.getPools(marketId);
        if (outcome >= keys.length) revert BadOutcome();
        OBMarket market = marketFactory.getMarket(marketId).market;

        usdg.safeTransferFrom(msg.sender, address(this), maxUsdgIn);
        poolManager.unlock(abi.encode(Buy(market, keys, outcome, sets, usdgDirect, maxUsdgIn)));

        // Everything left here belongs to the buyer: the outcome bought, unsold other outcomes, unused USDG.
        OutcomeToken[] memory tokens = market.allOutcomes();
        for (uint256 i; i < tokens.length; i++) {
            uint256 bal = IERC20(address(tokens[i])).balanceOf(address(this));
            if (i == outcome) tokensOut = bal;
            if (bal > 0) IERC20(address(tokens[i])).safeTransfer(to, bal);
        }
        if (tokensOut < minOut) revert InsufficientOutput(tokensOut, minOut);
        uint256 left = usdg.balanceOf(address(this));
        if (left > 0) usdg.safeTransfer(msg.sender, left);
        usdgPaid = maxUsdgIn - left;
        emit Bought(msg.sender, marketId, outcome, sets, usdgDirect, usdgPaid, tokensOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Buy memory b = abi.decode(data, (Buy));
        Currency usdgCur = Currency.wrap(address(usdg));
        uint256 n = b.keys.length;
        uint256[] memory owed = new uint256[](n);

        // 1. Sell `sets` of every other outcome. The PoolManager is owed the tokens; it owes us the USDG.
        uint256 usdgFromSales;
        if (b.sets > 0) {
            for (uint256 i; i < n; i++) {
                if (i == b.outcome) continue;
                (int128 outcomeDelta, int128 usdgDelta) = _swap(b.keys[i], false, b.sets);
                owed[i] = uint256(int256(-outcomeDelta));
                usdgFromSales += uint256(int256(usdgDelta));
            }
            if (usdgFromSales > 0) poolManager.take(usdgCur, address(this), usdgFromSales);
        }

        // 2. The direct buy: we owe the PoolManager the USDG it used; it owes us the outcome tokens.
        uint256 usdgOwed;
        if (b.usdgDirect > 0) {
            (int128 outcomeDelta, int128 usdgDelta) = _swap(b.keys[b.outcome], true, b.usdgDirect);
            usdgOwed = uint256(int256(-usdgDelta));
            if (outcomeDelta > 0) poolManager.take(_outcomeCur(b.keys[b.outcome]), address(this), uint256(int256(outcomeDelta)));
        }

        // 3. Mint the sets with the buyer's USDG plus the sales, keeping enough for the direct buy.
        uint256 have = b.usdgIn + usdgFromSales;
        if (have < b.sets + usdgOwed) revert NotEnoughUsdg(have, b.sets + usdgOwed);
        if (b.sets > 0) {
            usdg.forceApprove(address(b.market), b.sets);
            b.market.mintSet(b.sets, address(this));
        }

        // 4. Settle: USDG for the direct buy, outcome tokens for the sales.
        if (usdgOwed > 0) _pay(usdgCur, usdgOwed);
        for (uint256 i; i < n; i++) {
            if (owed[i] > 0) _pay(_outcomeCur(b.keys[i]), owed[i]);
        }
        return "";
    }

    /// Exact-input swap in an outcome's pool, stopping at the pool's price bound instead of failing (the same limits
    /// ForwarderFactory uses). Returns the outcome's and USDG's deltas: positive is owed to us.
    function _swap(PoolKey memory key, bool buyOutcome, uint256 amountIn) internal returns (int128 outcomeDelta, int128 usdgDelta) {
        bool usdgIs0 = Currency.unwrap(key.currency0) == address(usdg);
        bool zeroForOne = buyOutcome == usdgIs0; // buying pays USDG in; selling pays the outcome in
        (,, int24 tickLower, int24 tickUpper,,,,) = PFWAMarketHook(address(key.hooks)).pools(key.toId());
        uint160 limit = zeroForOne ? TickMath.getSqrtPriceAtTick(tickLower + 1) : TickMath.getSqrtPriceAtTick(tickUpper);
        BalanceDelta d = poolManager.swap(
            key, SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: limit}), ""
        );
        (outcomeDelta, usdgDelta) = usdgIs0 ? (d.amount1(), d.amount0()) : (d.amount0(), d.amount1());
    }

    function _outcomeCur(PoolKey memory key) internal view returns (Currency) {
        return Currency.unwrap(key.currency0) == address(usdg) ? key.currency1 : key.currency0;
    }

    function _pay(Currency cur, uint256 amount) internal {
        poolManager.sync(cur);
        IERC20(Currency.unwrap(cur)).safeTransfer(address(poolManager), amount);
        poolManager.settle();
    }
}

/// @title OBSetRouterFactory
/// @notice Deploys an OBSetRouter for any order book market factory. Permissionless; the factory keeps no state
/// beyond the event.
contract OBSetRouterFactory {
    event RouterCreated(address indexed router, address indexed marketFactory, address poolManager, address usdg);

    function create(IPoolManager poolManager, OBMarketFactory marketFactory, IERC20 usdg) external returns (OBSetRouter router) {
        router = new OBSetRouter(poolManager, marketFactory, usdg);
        emit RouterCreated(address(router), address(marketFactory), address(poolManager), address(usdg));
    }
}
