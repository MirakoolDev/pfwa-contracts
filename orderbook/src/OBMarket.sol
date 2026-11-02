// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {OutcomeToken} from "./OutcomeToken.sol";

/// @title OBMarket
/// @notice Holds one order book market's USDG and its outcome tokens' supply.
/// - Before resolution: deposit x USDG to mint x of every outcome (a complete set), or burn x of every
///   outcome to get x USDG back. Every outcome's supply always equals the USDG held.
/// - After resolution: each winning token redeems for 1 USDG. If the market is INVALID, every outcome
///   token redeems for 1/N USDG.
/// Deployed as an EIP-1167 clone by OBMarketFactory.
contract OBMarket {
    using SafeERC20 for IERC20;

    /// Outcome index meaning "the market was invalid": every outcome redeems for 1/N.
    uint8 public constant INVALID = type(uint8).max;

    IERC20 public collateral;
    address public factory;
    address public resolver;
    uint256 public marketId;
    uint64 public endOfTrading;
    /// @notice The most USDG this market may hold, for launch until audited (0 = no cap). Fixed at creation.
    uint256 public depositCap;
    OutcomeToken[] internal _outcomes;

    /// @notice Set when a result is posted: trading stops while the result can be disputed.
    bool public halted;
    bool public resolved;
    uint8 public winningOutcome;

    event SetMinted(address indexed account, address indexed to, uint256 amount);
    event SetBurned(address indexed account, address indexed to, uint256 amount);
    event Halted();
    event Finalized(uint8 outcome);
    event Redeemed(address indexed account, address indexed to, uint8 outcome, uint256 tokens, uint256 paid);

    error AlreadyInitialized();
    error NotResolver();
    error AlreadyResolved();
    error NotResolved();
    error BadOutcome();
    error ZeroAmount();
    error CapExceeded();

    /// The implementation can never be initialised: only its clones are.
    constructor() {
        factory = address(1);
    }

    function initialize(
        address factory_,
        address resolver_,
        IERC20 collateral_,
        uint256 marketId_,
        uint64 endOfTrading_,
        uint256 depositCap_,
        OutcomeToken[] calldata outcomes_
    ) external {
        if (factory != address(0)) revert AlreadyInitialized();
        factory = factory_;
        resolver = resolver_;
        collateral = collateral_;
        marketId = marketId_;
        endOfTrading = endOfTrading_;
        depositCap = depositCap_;
        for (uint256 i; i < outcomes_.length; i++) {
            _outcomes.push(outcomes_[i]);
        }
    }

    // ── Views ───────────────────────────────────────────────────────────────────

    function outcomeCount() external view returns (uint256) {
        return _outcomes.length;
    }

    function outcomes(uint256 i) external view returns (OutcomeToken) {
        return _outcomes[i];
    }

    function allOutcomes() external view returns (OutcomeToken[] memory) {
        return _outcomes;
    }

    /// True while swaps in this market's pools are allowed.
    function tradingOpen() external view returns (bool) {
        return !halted && !resolved && block.timestamp < endOfTrading;
    }

    // ── Complete sets ───────────────────────────────────────────────────────────

    /// @notice Deposit `amount` USDG and receive `amount` of every outcome token.
    function mintSet(uint256 amount, address to) external {
        if (amount == 0) revert ZeroAmount();
        if (resolved) revert AlreadyResolved();
        uint256 cap = depositCap;
        if (cap != 0 && _outcomes[0].totalSupply() + amount > cap) revert CapExceeded();
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        uint256 n = _outcomes.length;
        for (uint256 i; i < n; i++) {
            _outcomes[i].mint(to, amount);
        }
        emit SetMinted(msg.sender, to, amount);
    }

    /// @notice Burn `amount` of every outcome token and receive `amount` USDG. Only before resolution.
    function burnSet(uint256 amount, address to) external {
        if (amount == 0) revert ZeroAmount();
        if (resolved) revert AlreadyResolved();
        uint256 n = _outcomes.length;
        for (uint256 i; i < n; i++) {
            _outcomes[i].burn(msg.sender, amount);
        }
        collateral.safeTransfer(to, amount);
        emit SetBurned(msg.sender, to, amount);
    }

    // ── Resolution ──────────────────────────────────────────────────────────────

    /// @notice Called by the resolver when a result is posted: the pools stop trading.
    function halt() external {
        if (msg.sender != resolver) revert NotResolver();
        if (halted) return;
        halted = true;
        emit Halted();
    }

    /// @notice Called by the resolver once the outcome is final.
    function finalize(uint8 outcome) external {
        if (msg.sender != resolver) revert NotResolver();
        if (resolved) revert AlreadyResolved();
        if (outcome != INVALID && outcome >= _outcomes.length) revert BadOutcome();
        resolved = true;
        winningOutcome = outcome;
        emit Finalized(outcome);
    }

    /// @notice Burn `amount` tokens of outcome `outcome` and receive their payout.
    /// A winning token pays 1 USDG. If the market is INVALID, any outcome token pays 1/N USDG.
    function redeem(uint8 outcome, uint256 amount, address to) external returns (uint256 paid) {
        if (!resolved) revert NotResolved();
        if (amount == 0) revert ZeroAmount();
        if (outcome >= _outcomes.length) revert BadOutcome();
        if (winningOutcome == INVALID) {
            paid = amount / _outcomes.length; // rounds down, so the total paid never exceeds the balance
        } else {
            if (outcome != winningOutcome) revert BadOutcome();
            paid = amount;
        }
        _outcomes[outcome].burn(msg.sender, amount);
        if (paid > 0) collateral.safeTransfer(to, paid);
        emit Redeemed(msg.sender, to, outcome, amount, paid);
    }
}
