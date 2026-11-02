// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickBitmap} from "v4-core/src/libraries/TickBitmap.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {PFWAMarketHook, ITickMoveListener} from "./PFWAMarketHook.sol";
import {OBMarket} from "./OBMarket.sol";

/// @title PFWALimitOrders
/// @notice Limit orders on order book market pools. An order is one-sided liquidity in a single tick-spacing step
/// on the far side of the price: selling currency0 sits above the price, selling currency1 below it. When a swap
/// moves the price fully through the step, the order has turned into the other currency.
///
/// - Orders at the same step and direction share one position (an epoch), so a fill costs the same however many
///   traders are in it; each trader withdraws their share of what it turned into.
/// - The hook reports every swap's price move (`movePoolTick`), and the steps it crossed are filled in the same
///   transaction, up to MAX_FILLS_PER_SWAP. Anyone can fill the rest later with `fill`, while the price is still
///   past them; if it comes back first, those orders simply stay open.
/// - An unfilled order can be cancelled any time, also after the market closes (it gets back what its share of the
///   position holds then). Filled orders are withdrawn any time.
/// - No fee: makers pay nothing; the swap that fills an order already paid the market's fee.
/// No owner and no admin.
contract PFWALimitOrders is ITickMoveListener, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using TickBitmap for mapping(int16 => uint256);
    using SafeERC20 for IERC20;

    uint256 public constant MAX_FILLS_PER_SWAP = 8;

    struct Epoch {
        bool filled;
        Currency currency0;
        Currency currency1;
        uint128 liquidityTotal;
        uint256 token0Total;
        uint256 token1Total;
        mapping(address => uint128) liquidity;
    }

    IPoolManager public immutable poolManager;
    PFWAMarketHook public immutable hook;

    /// The current epoch for each (pool, step, direction). 0 means none open; ids start at 1.
    mapping(bytes32 => uint256) public epochOf;
    mapping(uint256 => Epoch) internal _epochs;
    uint256 public nextEpoch = 1;
    /// Steps with an open epoch, per pool and direction (true: selling currency0).
    mapping(PoolId => mapping(bool => mapping(int16 => uint256))) internal _active;

    enum Action {
        Place,
        Fill,
        Cancel
    }

    event Placed(address indexed owner, uint256 indexed epoch, PoolId indexed poolId, int24 tickLower, bool zeroForOne, uint128 liquidity, uint256 amountIn);
    event Filled(uint256 indexed epoch, PoolId indexed poolId, int24 tickLower, bool zeroForOne, uint256 amount0, uint256 amount1);
    event Cancelled(address indexed owner, uint256 indexed epoch, uint256 amount0, uint256 amount1);
    event Withdrawn(address indexed owner, uint256 indexed epoch, uint256 amount0, uint256 amount1);

    error NotHook();
    error NotPoolManager();
    error UnknownPool();
    error TradingClosed();
    error BadTick();
    error CrossedRange();
    error ZeroLiquidity();
    error NotFilled();
    error AlreadyFilled();
    error NothingToWithdraw();
    error NotCrossed();

    constructor(IPoolManager poolManager_, PFWAMarketHook hook_) {
        poolManager = poolManager_;
        hook = hook_;
    }

    // ── Place, cancel, withdraw ─────────────────────────────────────────────────

    /// @notice Places a limit order of `amountIn` of the input currency in the step starting at `tickLower`.
    /// `zeroForOne` true sells currency0 for currency1 and needs the step above the price; false sells currency1
    /// for currency0 and needs it below. Approve this contract for the input first. Returns the epoch.
    function place(PoolKey calldata key, int24 tickLower, bool zeroForOne, uint256 amountIn) external returns (uint256 epoch) {
        PoolId id = key.toId();
        (OBMarket market,, int24 boundLower, int24 boundUpper,,,, bool registered) = hook.pools(id);
        if (!registered) revert UnknownPool();
        if (!market.tradingOpen()) revert TradingClosed();
        int24 spacing = key.tickSpacing;
        int24 tickUpper = tickLower + spacing;
        if (tickLower % spacing != 0 || tickLower < boundLower || tickUpper > boundUpper) revert BadTick();
        (, int24 tick,,) = poolManager.getSlot0(id);
        if (zeroForOne ? tickLower <= tick : tickUpper > tick) revert CrossedRange();

        uint160 sqrtA = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(tickUpper);
        uint128 liquidity = zeroForOne
            ? LiquidityAmounts.getLiquidityForAmount0(sqrtA, sqrtB, amountIn)
            : LiquidityAmounts.getLiquidityForAmount1(sqrtA, sqrtB, amountIn);
        if (liquidity == 0) revert ZeroLiquidity();

        bytes32 slot = _slot(id, tickLower, zeroForOne);
        epoch = epochOf[slot];
        if (epoch == 0) {
            epoch = nextEpoch++;
            epochOf[slot] = epoch;
            Epoch storage fresh = _epochs[epoch];
            fresh.currency0 = key.currency0;
            fresh.currency1 = key.currency1;
            _active[id][zeroForOne].flipTick(tickLower, spacing);
        }
        Epoch storage e = _epochs[epoch];
        e.liquidityTotal += liquidity;
        e.liquidity[msg.sender] += liquidity;

        poolManager.unlock(abi.encode(Action.Place, key, tickLower, zeroForOne, int256(uint256(liquidity)), msg.sender));
        emit Placed(msg.sender, epoch, id, tickLower, zeroForOne, liquidity, amountIn);
    }

    /// @notice Cancels the caller's share of an unfilled order and sends what it holds now to `to`.
    function cancel(PoolKey calldata key, int24 tickLower, bool zeroForOne, address to)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        PoolId id = key.toId();
        bytes32 slot = _slot(id, tickLower, zeroForOne);
        uint256 epoch = epochOf[slot];
        Epoch storage e = _epochs[epoch];
        uint128 liquidity = e.liquidity[msg.sender];
        if (epoch == 0 || liquidity == 0) revert NothingToWithdraw();
        e.liquidity[msg.sender] = 0;
        e.liquidityTotal -= liquidity;
        if (e.liquidityTotal == 0) {
            delete epochOf[slot];
            _active[id][zeroForOne].flipTick(tickLower, key.tickSpacing);
        }
        bytes memory out =
            poolManager.unlock(abi.encode(Action.Cancel, key, tickLower, zeroForOne, -int256(uint256(liquidity)), to));
        (amount0, amount1) = abi.decode(out, (uint256, uint256));
        emit Cancelled(msg.sender, epoch, amount0, amount1);
    }

    /// @notice Withdraws the caller's share of a filled epoch to `to`.
    function withdraw(uint256 epoch, address to) external returns (uint256 amount0, uint256 amount1) {
        Epoch storage e = _epochs[epoch];
        if (!e.filled) revert NotFilled();
        uint128 liquidity = e.liquidity[msg.sender];
        if (liquidity == 0) revert NothingToWithdraw();
        uint128 total = e.liquidityTotal;
        amount0 = (e.token0Total * liquidity) / total;
        amount1 = (e.token1Total * liquidity) / total;
        e.liquidity[msg.sender] = 0;
        e.liquidityTotal = total - liquidity;
        e.token0Total -= amount0;
        e.token1Total -= amount1;
        if (amount0 > 0) IERC20(Currency.unwrap(e.currency0)).safeTransfer(to, amount0);
        if (amount1 > 0) IERC20(Currency.unwrap(e.currency1)).safeTransfer(to, amount1);
        emit Withdrawn(msg.sender, epoch, amount0, amount1);
    }

    /// @notice Fills an open order whose step the price is fully past now (one a swap crossed beyond its per-swap cap).
    function fill(PoolKey calldata key, int24 tickLower, bool zeroForOne) external {
        PoolId id = key.toId();
        (, int24 tick,,) = poolManager.getSlot0(id);
        if (zeroForOne ? tick < tickLower + key.tickSpacing : tick >= tickLower) revert NotCrossed();
        if (epochOf[_slot(id, tickLower, zeroForOne)] == 0) revert NothingToWithdraw();
        poolManager.unlock(abi.encode(Action.Fill, key, tickLower, zeroForOne, int256(0), address(0)));
    }

    // ── The hook's report ───────────────────────────────────────────────────────

    /// @notice Called by the hook after every swap: fills the steps the price fully crossed, up to the cap.
    function movePoolTick(PoolKey calldata key, int24 fromTick, int24 toTick, uint160) external {
        if (msg.sender != address(hook)) revert NotHook();
        if (toTick == fromTick) return;
        PoolId id = key.toId();
        int24 spacing = key.tickSpacing;
        uint256 fills;
        if (toTick > fromTick) {
            // Price rose: sells of currency0 in steps [L, L + spacing] with L + spacing <= toTick are now all currency1.
            mapping(int16 => uint256) storage active = _active[id][true];
            int24 t = _floor(fromTick, spacing) - spacing;
            while (fills < MAX_FILLS_PER_SWAP) {
                (int24 next, bool initialized) = active.nextInitializedTickWithinOneWord(t, spacing, false);
                if (next + spacing > toTick) break;
                if (initialized) {
                    _fillStep(key, id, next, true);
                    ++fills;
                }
                t = next;
            }
        } else {
            // Price fell: sells of currency1 in steps [L, L + spacing] with L > toTick are now all currency0.
            mapping(int16 => uint256) storage active = _active[id][false];
            int24 t = _floor(fromTick, spacing);
            while (fills < MAX_FILLS_PER_SWAP) {
                (int24 next, bool initialized) = active.nextInitializedTickWithinOneWord(t, spacing, true);
                if (next <= toTick) break;
                if (initialized) {
                    _fillStep(key, id, next, false);
                    ++fills;
                }
                t = next - 1;
            }
        }
    }

    // ── PoolManager ─────────────────────────────────────────────────────────────

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Action action, PoolKey memory key, int24 tickLower, bool zeroForOne, int256 liquidityDelta, address who) =
            abi.decode(data, (Action, PoolKey, int24, bool, int256, address));
        if (action == Action.Fill) {
            _fillStep(key, key.toId(), tickLower, zeroForOne);
            return "";
        }
        BalanceDelta delta = _modify(key, tickLower, zeroForOne, liquidityDelta);
        if (action == Action.Place) {
            // Adding liquidity: pay the PoolManager what it asks, pulled from the trader.
            _pay(key.currency0, who, delta.amount0());
            _pay(key.currency1, who, delta.amount1());
            return "";
        }
        // Cancel: take what the share holds to the trader.
        uint256 amount0 = _take(key.currency0, who, delta.amount0());
        uint256 amount1 = _take(key.currency1, who, delta.amount1());
        return abi.encode(amount0, amount1);
    }

    function _fillStep(PoolKey memory key, PoolId id, int24 tickLower, bool zeroForOne) internal {
        bytes32 slot = _slot(id, tickLower, zeroForOne);
        uint256 epoch = epochOf[slot];
        if (epoch == 0) return;
        Epoch storage e = _epochs[epoch];
        delete epochOf[slot];
        _active[id][zeroForOne].flipTick(tickLower, key.tickSpacing);
        BalanceDelta delta = _modify(key, tickLower, zeroForOne, -int256(uint256(e.liquidityTotal)));
        uint256 amount0 = _take(key.currency0, address(this), delta.amount0());
        uint256 amount1 = _take(key.currency1, address(this), delta.amount1());
        e.filled = true;
        e.token0Total += amount0;
        e.token1Total += amount1;
        emit Filled(epoch, id, tickLower, zeroForOne, amount0, amount1);
    }

    function _modify(PoolKey memory key, int24 tickLower, bool zeroForOne, int256 liquidityDelta)
        internal
        returns (BalanceDelta delta)
    {
        (delta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickLower + key.tickSpacing,
                liquidityDelta: liquidityDelta,
                salt: bytes32(uint256(zeroForOne ? 1 : 0))
            }),
            ""
        );
    }

    function _pay(Currency currency, address from, int128 amount) internal {
        if (amount >= 0) return;
        poolManager.sync(currency);
        IERC20(Currency.unwrap(currency)).safeTransferFrom(from, address(poolManager), uint256(uint128(-amount)));
        poolManager.settle();
    }

    function _take(Currency currency, address to, int128 amount) internal returns (uint256 taken) {
        if (amount <= 0) return 0;
        taken = uint256(uint128(amount));
        poolManager.take(currency, to, taken);
    }

    // ── Views ───────────────────────────────────────────────────────────────────

    function epochInfo(uint256 epoch)
        external
        view
        returns (bool filled, uint128 liquidityTotal, uint256 token0Total, uint256 token1Total)
    {
        Epoch storage e = _epochs[epoch];
        return (e.filled, e.liquidityTotal, e.token0Total, e.token1Total);
    }

    function liquidityOf(uint256 epoch, address owner) external view returns (uint128) {
        return _epochs[epoch].liquidity[owner];
    }

    function _slot(PoolId id, int24 tickLower, bool zeroForOne) internal pure returns (bytes32) {
        return keccak256(abi.encode(id, tickLower, zeroForOne));
    }

    function _floor(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 q = tick / spacing;
        if (tick < 0 && tick % spacing != 0) q -= 1;
        return q * spacing;
    }
}
