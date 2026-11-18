// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ICurveMarkets {
    function getOptionTokenAddresses(uint256 marketId) external view returns (address[] memory);
}

interface ICurveToken {
    function buy(uint256 tokenAmount) external payable;
    function tokensForEth(uint256 ethAmount) external view returns (uint256);
    function costToBuyWithFee(uint256 tokenAmount) external view returns (uint256);
    function feePercentage() external view returns (uint256);
}

/// @title CurveIntentDeposit
/// @notice A one-time deposit address for a cross-chain buy. NEAR Intents delivers ETH here; the forwarder then
/// spends it on the order, or returns it to the user. Deployed as a deterministic clone.
contract CurveIntentDeposit {
    address public forwarder;

    error NotForwarder();
    error AlreadyInitialized();
    error SendFailed();

    receive() external payable {}

    function initialize() external {
        if (forwarder != address(0)) revert AlreadyInitialized();
        forwarder = msg.sender;
    }

    /// Send all of this address's ETH to `to`. Only the forwarder, which enforces the order's rules.
    function release(address to) external returns (uint256 amount) {
        if (msg.sender != forwarder) revert NotForwarder();
        amount = address(this).balance;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert SendFailed();
    }
}

/// @title CurveIntentForwarder
/// @notice Buy shares in a bonding curve market from any chain, through NEAR Intents.
/// 1. The app computes `depositAddress(order)` and asks NEAR Intents' 1Click API to deliver ETH on Robinhood Chain
///    there.
/// 2. Once delivered, anyone (the app's keeper) calls `execute(order)`: the forwarder buys the order's option with all
///    of that ETH, after the market's fees, and sends the shares to the user. It fails if the user would get fewer
///    than `minShares`. ETH the curve doesn't use goes back to the user.
/// 3. If the order can't fill, the user can call `refund(order)` at any time, and anyone can after the deadline.
///    The ETH goes to the user on Robinhood Chain.
/// The order is its own record: its deposit address is CREATE2 of the order's hash, so a made-up order points at an
/// empty address and nothing happens. One forwarder serves one market factory, given at deployment.
contract CurveIntentForwarder is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Order {
        address user; // receives the shares or the refund
        uint256 marketId;
        uint8 option;
        uint256 minShares; // minimum shares for the whole deposit
        uint64 deadline;
        uint256 nonce; // lets the same user place identical orders
    }

    ICurveMarkets public immutable markets;
    address public immutable depositImplementation;

    /// `buyer` is the user the shares went to; the market's own TokensBought event names this forwarder.
    event Executed(address indexed deposit, address indexed buyer, uint256 indexed marketId, uint8 option, address token, uint256 ethIn, uint256 shares);
    event Refunded(address indexed deposit, address indexed user, uint256 amount);

    error NothingDeposited();
    error Expired();
    error NotYet();
    error NoSuchOption();
    error InsufficientOutput(uint256 shares, uint256 minShares);
    error SendFailed();

    constructor(ICurveMarkets markets_) {
        markets = markets_;
        depositImplementation = address(new CurveIntentDeposit());
    }

    /// Receives the deposit's ETH and the curve's refund of overpayment while an order executes.
    receive() external payable {}

    function orderSalt(Order calldata o) public pure returns (bytes32) {
        return keccak256(abi.encode(o));
    }

    /// @notice Where NEAR Intents should deliver the ETH for `o`.
    function depositAddress(Order calldata o) external view returns (address) {
        return Clones.predictDeterministicAddress(depositImplementation, orderSalt(o), address(this));
    }

    /// @notice Shares `ethIn` buys on `token` right now, after the market's fees: what execute would buy.
    function sharesFor(address token, uint256 ethIn) public view returns (uint256 shares) {
        ICurveToken t = ICurveToken(token);
        uint256 fee = t.feePercentage();
        shares = t.tokensForEth((ethIn * 1000) / (1000 + 2 * fee));
        // tokensForEth rounds; step down until the buy, fees included, fits in ethIn.
        for (uint256 i; i < 8 && shares > 0 && t.costToBuyWithFee(shares) > ethIn; i++) {
            shares = (shares * 9999) / 10000;
        }
    }

    function tokenOf(uint256 marketId, uint8 option) public view returns (address) {
        address[] memory tokens = markets.getOptionTokenAddresses(marketId);
        if (option >= tokens.length) revert NoSuchOption();
        return tokens[option];
    }

    function execute(Order calldata o) external nonReentrant returns (uint256 shares) {
        if (block.timestamp > o.deadline) revert Expired();
        address token = tokenOf(o.marketId, o.option);
        CurveIntentDeposit d = _deposit(o);
        if (address(d).balance == 0) revert NothingDeposited();

        uint256 before = address(this).balance;
        uint256 ethIn = d.release(address(this));
        shares = sharesFor(token, ethIn);
        if (shares < o.minShares || shares == 0) revert InsufficientOutput(shares, o.minShares);

        ICurveToken(token).buy{value: ethIn}(shares); // the curve refunds what it didn't use, to this contract
        IERC20(token).safeTransfer(o.user, shares);

        uint256 left = address(this).balance - before;
        if (left > 0) _send(o.user, left);
        emit Executed(address(d), o.user, o.marketId, o.option, token, ethIn - left, shares);
    }

    function refund(Order calldata o) external nonReentrant {
        if (msg.sender != o.user && block.timestamp <= o.deadline) revert NotYet();
        CurveIntentDeposit d = _deposit(o);
        if (address(d).balance == 0) revert NothingDeposited();
        uint256 amount = d.release(o.user);
        emit Refunded(address(d), o.user, amount);
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert SendFailed();
    }

    function _deposit(Order calldata o) internal returns (CurveIntentDeposit d) {
        bytes32 salt = orderSalt(o);
        address predicted = Clones.predictDeterministicAddress(depositImplementation, salt, address(this));
        if (predicted.code.length == 0) {
            Clones.cloneDeterministic(depositImplementation, salt);
            CurveIntentDeposit(payable(predicted)).initialize();
        }
        d = CurveIntentDeposit(payable(predicted));
    }
}
