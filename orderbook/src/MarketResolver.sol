// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {OBMarket} from "./OBMarket.sol";

/// @title MarketResolver
/// @notice Resolves order book markets the way PFWA's bonding curve markets resolve today, plus one short dispute
/// step before winners can redeem.
///
///   Open ──resolveMarket(outcome)──▶ Pending (trading stops) ──2 hours, no dispute──▶ finalize() ──▶ Final
///   Pending ──dispute() + bond──▶ Disputed ──settleDispute(outcome), by the owner──▶ Final
///
/// - Who may resolve is PFWAMarketFactory.resolveMarket's rule: the market's creator; the relayer (the resolver
///   bot, which reads the market's data source) for platform markets; the owner; and the relayer or the owner once
///   the market is 24 hours past its end of trading.
/// - Anyone may dispute a pending result within 2 hours by posting the market's bond in USDG. The owner (the PFWA
///   multisig) then confirms or corrects it. A disputer who was right gets the bond back; one who was wrong loses it
///   to the fee collector.
/// - An undisputed result becomes final when the window ends; anyone can call finalize().
contract MarketResolver {
    using SafeERC20 for IERC20;

    enum State {
        None,
        Open,
        Pending,
        Disputed,
        Final
    }

    struct Resolution {
        OBMarket market;
        address creator;
        uint64 endOfTrading;
        uint64 disputeEnds;
        State state;
        uint8 outcome;
        uint256 bond;
        address disputer;
    }

    /// @notice How long a result can be disputed before it's final.
    uint32 public constant DISPUTE_WINDOW = 2 hours;
    /// @notice After this long past end of trading, the relayer or owner may resolve any market (as on the
    /// bonding curve factory's postExpirationGrace).
    uint32 public constant RESOLVE_GRACE = 24 hours;

    IERC20 public immutable usdg;
    address public immutable deployer;
    address public factory;
    address public owner;
    address public pendingOwner;
    /// @notice The resolver bot: resolves platform markets from their data source.
    address public relayer;
    address public feeCollector;
    /// @notice Creators whose markets the relayer resolves (PFWA's own wallets), besides the owner and the relayer.
    mapping(address => bool) public isPlatform;

    mapping(uint256 => Resolution) public resolutions;

    event Registered(uint256 indexed marketId, address market, address creator, uint64 endOfTrading, uint256 bond);
    event Resolved(uint256 indexed marketId, address indexed by, uint8 outcome, uint64 disputeEnds);
    event Disputed(uint256 indexed marketId, address indexed disputer, uint256 bond);
    event DisputeSettled(uint256 indexed marketId, uint8 outcome, bool disputerWasRight);
    event Finalized(uint256 indexed marketId, uint8 outcome);
    event RelayerSet(address relayer);
    event FeeCollectorSet(address feeCollector);
    event PlatformSet(address indexed creator, bool isPlatform);
    event OwnerProposed(address pendingOwner);
    event OwnerChanged(address owner);

    error NotFactory();
    error NotOwner();
    error NotDeployer();
    error AlreadySet();
    error WrongState();
    error NotAllowedToResolve();
    error DisputeWindowOver();
    error DisputeWindowOpen();
    error BadOutcome();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IERC20 usdg_, address owner_, address relayer_, address feeCollector_) {
        if (owner_ == address(0) || feeCollector_ == address(0)) revert ZeroAddress();
        usdg = usdg_;
        deployer = msg.sender;
        owner = owner_;
        relayer = relayer_;
        feeCollector = feeCollector_;
    }

    /// One-time wiring by the deployer (the factory is deployed after this contract).
    function setFactory(address factory_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (factory != address(0)) revert AlreadySet();
        factory = factory_;
    }

    function register(uint256 marketId, OBMarket market, address creator, uint64 endOfTrading, uint256 bond) external {
        if (msg.sender != factory) revert NotFactory();
        resolutions[marketId] = Resolution({
            market: market,
            creator: creator,
            endOfTrading: endOfTrading,
            disputeEnds: 0,
            state: State.Open,
            outcome: 0,
            bond: bond,
            disputer: address(0)
        });
        emit Registered(marketId, address(market), creator, endOfTrading, bond);
    }

    // ── Resolve, dispute, finalize ──────────────────────────────────────────────

    /// @notice Sets the market's result and stops its trading. The result is final after DISPUTE_WINDOW unless
    /// someone disputes it. Use OBMarket.INVALID (255) when no outcome can be called.
    function resolveMarket(uint256 marketId, uint8 outcome) external {
        Resolution storage r = resolutions[marketId];
        if (r.state != State.Open) revert WrongState();
        if (!mayResolve(marketId, msg.sender)) revert NotAllowedToResolve();
        _checkOutcome(r, outcome);
        r.state = State.Pending;
        r.outcome = outcome;
        r.disputeEnds = uint64(block.timestamp) + DISPUTE_WINDOW;
        r.market.halt();
        emit Resolved(marketId, msg.sender, outcome, r.disputeEnds);
    }

    /// @notice Disputes a pending result within the window, posting the market's bond in USDG.
    function dispute(uint256 marketId) external {
        Resolution storage r = resolutions[marketId];
        if (r.state != State.Pending) revert WrongState();
        if (block.timestamp >= r.disputeEnds) revert DisputeWindowOver();
        r.state = State.Disputed;
        r.disputer = msg.sender;
        usdg.safeTransferFrom(msg.sender, address(this), r.bond);
        emit Disputed(marketId, msg.sender, r.bond);
    }

    /// @notice Makes an undisputed result final once the window has passed. Anyone can call it.
    function finalize(uint256 marketId) external {
        Resolution storage r = resolutions[marketId];
        if (r.state != State.Pending) revert WrongState();
        if (block.timestamp < r.disputeEnds) revert DisputeWindowOpen();
        r.state = State.Final;
        r.market.finalize(r.outcome);
        emit Finalized(marketId, r.outcome);
    }

    /// @notice The owner settles a dispute with the final result. If it differs from the disputed one, the disputer
    /// was right and gets the bond back; otherwise the bond goes to the fee collector.
    function settleDispute(uint256 marketId, uint8 outcome) external onlyOwner {
        Resolution storage r = resolutions[marketId];
        if (r.state != State.Disputed) revert WrongState();
        _checkOutcome(r, outcome);
        bool disputerWasRight = outcome != r.outcome;
        r.state = State.Final;
        r.outcome = outcome;
        if (r.bond > 0) usdg.safeTransfer(disputerWasRight ? r.disputer : feeCollector, r.bond);
        r.market.finalize(outcome);
        emit DisputeSettled(marketId, outcome, disputerWasRight);
        emit Finalized(marketId, outcome);
    }

    // ── Views ───────────────────────────────────────────────────────────────────

    /// @notice Whether `who` may resolve the market now (PFWAMarketFactory.resolveMarket's rule).
    function mayResolve(uint256 marketId, address who) public view returns (bool) {
        Resolution storage r = resolutions[marketId];
        if (who == r.creator || who == owner) return true;
        if (who != relayer) return false;
        return isPlatform[r.creator] || r.creator == owner || r.creator == relayer
            || block.timestamp >= uint256(r.endOfTrading) + RESOLVE_GRACE;
    }

    function _checkOutcome(Resolution storage r, uint8 outcome) internal view {
        if (outcome != r.market.INVALID() && outcome >= r.market.outcomeCount()) revert BadOutcome();
    }

    // ── Owner ───────────────────────────────────────────────────────────────────

    function setRelayer(address next) external onlyOwner {
        relayer = next;
        emit RelayerSet(next);
    }

    function setFeeCollector(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        feeCollector = next;
        emit FeeCollectorSet(next);
    }

    function setPlatform(address creator, bool platform) external onlyOwner {
        isPlatform[creator] = platform;
        emit PlatformSet(creator, platform);
    }

    function setOwner(address next) external onlyOwner {
        pendingOwner = next;
        emit OwnerProposed(next);
    }

    function acceptOwner() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        owner = msg.sender;
        delete pendingOwner;
        emit OwnerChanged(msg.sender);
    }
}
