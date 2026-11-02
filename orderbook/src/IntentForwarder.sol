// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {OBMarketFactory} from "./OBMarketFactory.sol";

/// @title IntentDeposit
/// @notice A one-time deposit address for a cross-chain order. NEAR Intents delivers USDG here; the
/// ForwarderFactory then spends it on the order, or returns it to the user. Deployed as a deterministic clone.
contract IntentDeposit {
    using SafeERC20 for IERC20;

    address public factory;

    error NotFactory();
    error AlreadyInitialized();

    function initialize() external {
        if (factory != address(0)) revert AlreadyInitialized();
        factory = msg.sender;
    }

    /// Send `amount` of `token` to `to`. Only the factory, which enforces the order's rules.
    function release(IERC20 token, address to, uint256 amount) external {
        if (msg.sender != factory) revert NotFactory();
        token.safeTransfer(to, amount);
    }
}

/// @title ForwarderFactory
/// @notice Cross-chain buying through NEAR Intents.
/// 1. The backend computes `depositAddress(order)` and asks NEAR Intents' 1Click API to deliver USDG there.
/// 2. Once delivered, a keeper calls `execute(order)`: the factory deploys the deposit clone and buys
///    the order's outcome with all of its USDG, sending the tokens to the user. Fails if the user would
///    receive less than `minOut`.
/// 3. If the order can't fill, the user can call `refund(order)` at any time, and anyone can after the
///    deadline. The USDG goes back to the user.
contract ForwarderFactory is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Order {
        address user; // receives the outcome tokens or the refund
        uint256 marketId;
        uint8 outcome;
        uint256 minOut; // minimum outcome tokens for the whole deposit
        uint64 deadline;
        uint256 nonce; // lets the same user place identical orders
    }

    struct SwapCallback {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
        address recipient;
    }

    IPoolManager public immutable poolManager;
    OBMarketFactory public immutable marketFactory;
    IERC20 public immutable usdg;
    address public immutable depositImplementation;

    event Executed(address indexed deposit, address indexed user, uint256 indexed marketId, uint8 outcome, uint256 usdgIn, uint256 tokensOut);
    event Refunded(address indexed deposit, address indexed user, uint256 amount);

    error NotPoolManager();
    error NothingDeposited();
    error Expired();
    error NotYet();
    error InsufficientOutput(uint256 out, uint256 minOut);

    constructor(IPoolManager poolManager_, OBMarketFactory marketFactory_, IERC20 usdg_) {
        poolManager = poolManager_;
        marketFactory = marketFactory_;
        usdg = usdg_;
        depositImplementation = address(new IntentDeposit());
    }

    function orderSalt(Order calldata o) public pure returns (bytes32) {
        return keccak256(abi.encode(o));
    }

    /// @notice Where NEAR Intents should deliver the USDG for `o`.
    function depositAddress(Order calldata o) external view returns (address) {
        return Clones.predictDeterministicAddress(depositImplementation, orderSalt(o), address(this));
    }

    function execute(Order calldata o) external nonReentrant returns (uint256 tokensOut) {
        if (block.timestamp > o.deadline) revert Expired();
        IntentDeposit d = _deposit(o);
        uint256 amountIn = usdg.balanceOf(address(d));
        if (amountIn == 0) revert NothingDeposited();
        d.release(usdg, address(this), amountIn);

        PoolKey memory key = marketFactory.getPools(o.marketId)[o.outcome];
        bool usdgIsCurrency0 = Currency.unwrap(key.currency0) == address(usdg);
        IERC20 outcomeToken = IERC20(Currency.unwrap(usdgIsCurrency0 ? key.currency1 : key.currency0));

        uint256 before = outcomeToken.balanceOf(o.user);
        poolManager.unlock(abi.encode(SwapCallback(key, usdgIsCurrency0, amountIn, o.user)));
        tokensOut = outcomeToken.balanceOf(o.user) - before;
        if (tokensOut < o.minOut) revert InsufficientOutput(tokensOut, o.minOut);

        // A partial fill leaves USDG here: return it to the user.
        uint256 left = usdg.balanceOf(address(this));
        if (left > 0) usdg.safeTransfer(o.user, left);
        emit Executed(address(d), o.user, o.marketId, o.outcome, amountIn - left, tokensOut);
    }

    function refund(Order calldata o) external nonReentrant {
        if (msg.sender != o.user && block.timestamp <= o.deadline) revert NotYet();
        IntentDeposit d = _deposit(o);
        uint256 amount = usdg.balanceOf(address(d));
        if (amount == 0) revert NothingDeposited();
        d.release(usdg, o.user, amount);
        emit Refunded(address(d), o.user, amount);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        SwapCallback memory s = abi.decode(data, (SwapCallback));
        BalanceDelta delta = poolManager.swap(
            s.key,
            SwapParams({
                zeroForOne: s.zeroForOne,
                amountSpecified: -int256(s.amountIn),
                sqrtPriceLimitX96: s.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (int128 inDelta, int128 outDelta) = s.zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        Currency inCur = s.zeroForOne ? s.key.currency0 : s.key.currency1;
        Currency outCur = s.zeroForOne ? s.key.currency1 : s.key.currency0;

        uint256 owed = uint256(int256(-inDelta));
        poolManager.sync(inCur);
        IERC20(Currency.unwrap(inCur)).safeTransfer(address(poolManager), owed);
        poolManager.settle();
        if (outDelta > 0) poolManager.take(outCur, s.recipient, uint256(int256(outDelta)));
        return "";
    }

    function _deposit(Order calldata o) internal returns (IntentDeposit d) {
        bytes32 salt = orderSalt(o);
        address predicted = Clones.predictDeterministicAddress(depositImplementation, salt, address(this));
        if (predicted.code.length == 0) {
            Clones.cloneDeterministic(depositImplementation, salt);
            IntentDeposit(predicted).initialize();
        }
        d = IntentDeposit(predicted);
    }
}
