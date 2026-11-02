// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {OBMarket} from "./OBMarket.sol";
import {OutcomeToken} from "./OutcomeToken.sol";
import {PFWAMarketHook} from "./PFWAMarketHook.sol";
import {MarketResolver} from "./MarketResolver.sol";

/// @title OBMarketFactory
/// @notice Creates order book markets: clones the market and its outcome tokens, opens one Uniswap v4 pool
/// per outcome against USDG on the PFWA hook, and registers the market with the resolver.
/// Holds no user funds.
contract OBMarketFactory is Ownable {
    using SafeERC20 for IERC20;

    struct CreateParams {
        bytes32 setupHash; // fingerprint of the market's rules and data source
        string question;
        string[] outcomeNames; // 2..10
        uint16[] openingBps; // opening price per outcome in bps of 1 USDG; empty = even split
        uint64 endOfTrading;
        uint16 creatorFeeBps;
    }

    struct MarketInfo {
        OBMarket market;
        address creator;
        bytes32 setupHash;
        string question;
    }

    uint256 public constant FIRST_MARKET_ID = 200_000;
    uint256 public constant MAX_OUTCOMES = 10;
    uint16 public constant MAX_CREATOR_FEE_BPS = 200;
    uint16 public constant MAX_PROTOCOL_FEE_BPS = 200;
    int24 public constant TICK_SPACING = 10;
    /// Price bounds in bps of 1 USDG: 0.001 and 0.999.
    uint256 public constant MIN_PRICE_BPS = 10;
    uint256 public constant MAX_PRICE_BPS = 9_990;

    IPoolManager public immutable poolManager;
    PFWAMarketHook public immutable hook;
    MarketResolver public immutable resolver;
    IERC20 public immutable usdg;
    address public immutable marketImplementation;
    address public immutable tokenImplementation;

    uint16 public protocolFeeBps = 100;
    uint256 public creationFee; // in USDG
    uint256 public defaultBond = 50e6; // 50 USDG
    /// The most USDG each new market may hold, for launch until audited (0 = no cap).
    uint256 public depositCap;
    bool public creationPaused;

    uint256 public nextMarketId = FIRST_MARKET_ID;
    mapping(uint256 => MarketInfo) internal _markets;
    mapping(uint256 => PoolKey[]) internal _pools;

    event MarketCreated(
        uint256 indexed marketId,
        address indexed market,
        address indexed creator,
        bytes32 setupHash,
        string question,
        address[] outcomes,
        uint64 endOfTrading
    );
    event ParamsUpdated(uint16 protocolFeeBps, uint256 creationFee, uint256 defaultBond);
    event CreationPaused(bool paused);
    event DepositCapSet(uint256 depositCap);

    error CreationIsPaused();
    error BadOutcomeCount();
    error BadOpeningPrices();
    error BadEndOfTrading();
    error FeeTooHigh();
    error UnknownMarket();

    constructor(
        address owner_,
        IPoolManager poolManager_,
        PFWAMarketHook hook_,
        MarketResolver resolver_,
        IERC20 usdg_,
        uint256 creationFee_
    ) Ownable(owner_) {
        poolManager = poolManager_;
        hook = hook_;
        resolver = resolver_;
        usdg = usdg_;
        creationFee = creationFee_;
        marketImplementation = address(new OBMarket());
        tokenImplementation = address(new OutcomeToken());
    }

    // ── Create ──────────────────────────────────────────────────────────────────

    function createMarket(CreateParams calldata p) external returns (uint256 marketId) {
        if (creationPaused) revert CreationIsPaused();
        uint256 n = p.outcomeNames.length;
        if (n < 2 || n > MAX_OUTCOMES) revert BadOutcomeCount();
        if (p.endOfTrading <= block.timestamp) revert BadEndOfTrading();
        if (p.creatorFeeBps > MAX_CREATOR_FEE_BPS) revert FeeTooHigh();
        uint16[] memory opening = _openingPrices(p.openingBps, n);

        if (creationFee > 0) usdg.safeTransferFrom(msg.sender, hook.feeCollector(), creationFee);

        marketId = nextMarketId++;
        OBMarket market = OBMarket(Clones.clone(marketImplementation));
        OutcomeToken[] memory tokens = new OutcomeToken[](n);
        address[] memory tokenAddrs = new address[](n);
        for (uint256 i; i < n; i++) {
            tokens[i] = OutcomeToken(Clones.clone(tokenImplementation));
            tokens[i].initialize(p.outcomeNames[i], p.outcomeNames[i], address(market));
            tokenAddrs[i] = address(tokens[i]);
        }
        market.initialize(address(this), address(resolver), usdg, marketId, p.endOfTrading, depositCap, tokens);
        _markets[marketId] = MarketInfo(market, msg.sender, p.setupHash, p.question);

        for (uint256 i; i < n; i++) {
            _openPool(marketId, market, address(tokens[i]), opening[i], msg.sender, p.creatorFeeBps);
        }

        resolver.register(marketId, market, msg.sender, p.endOfTrading, defaultBond);
        emit MarketCreated(marketId, address(market), msg.sender, p.setupHash, p.question, tokenAddrs, p.endOfTrading);
    }

    function _openPool(
        uint256 marketId,
        OBMarket market,
        address outcome,
        uint256 openingBps,
        address creator,
        uint16 creatorFeeBps
    ) internal {
        bool usdgIsCurrency0 = address(usdg) < outcome;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(usdgIsCurrency0 ? address(usdg) : outcome),
            currency1: Currency.wrap(usdgIsCurrency0 ? outcome : address(usdg)),
            fee: 0,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        (int24 tickLower, int24 tickUpper) = priceBoundsInTicks(usdgIsCurrency0);
        hook.registerPool(
            key,
            PFWAMarketHook.PoolConfig({
                market: market,
                usdgIsCurrency0: usdgIsCurrency0,
                tickLower: tickLower,
                tickUpper: tickUpper,
                creator: creator,
                creatorFeeBps: creatorFeeBps,
                protocolFeeBps: protocolFeeBps,
                registered: true
            })
        );
        poolManager.initialize(key, sqrtPriceForBps(openingBps, usdgIsCurrency0));
        _pools[marketId].push(key);
    }

    function _openingPrices(uint16[] calldata given, uint256 n) internal pure returns (uint16[] memory out) {
        out = new uint16[](n);
        if (given.length == 0) {
            for (uint256 i; i < n; i++) {
                out[i] = uint16(10_000 / n);
            }
            return out;
        }
        if (given.length != n) revert BadOpeningPrices();
        for (uint256 i; i < n; i++) {
            if (given[i] < MIN_PRICE_BPS || given[i] > MAX_PRICE_BPS) revert BadOpeningPrices();
            out[i] = given[i];
        }
    }

    // ── Price math ──────────────────────────────────────────────────────────────

    /// @notice sqrtPriceX96 for an outcome priced at `bps` of 1 USDG.
    /// Both tokens have 6 decimals, so the raw price ratio equals the human price.
    /// The pool's price is currency1 per currency0: `bps/10000` when the outcome is currency0,
    /// and its inverse when USDG is currency0.
    function sqrtPriceForBps(uint256 bps, bool usdgIsCurrency0) public pure returns (uint160) {
        (uint256 num, uint256 den) = usdgIsCurrency0 ? (uint256(10_000), bps) : (bps, uint256(10_000));
        return uint160(Math.sqrt(Math.mulDiv(num, 1 << 192, den)));
    }

    /// @notice The tick range that keeps an outcome between 0.001 and 0.999 USDG.
    function priceBoundsInTicks(bool usdgIsCurrency0) public pure returns (int24 tickLower, int24 tickUpper) {
        int24 a = TickMath.getTickAtSqrtPrice(sqrtPriceForBps(MIN_PRICE_BPS, usdgIsCurrency0));
        int24 b = TickMath.getTickAtSqrtPrice(sqrtPriceForBps(MAX_PRICE_BPS, usdgIsCurrency0));
        (tickLower, tickUpper) = a < b ? (a, b) : (b, a);
    }

    // ── Views ───────────────────────────────────────────────────────────────────

    function getMarket(uint256 marketId) external view returns (MarketInfo memory) {
        if (address(_markets[marketId].market) == address(0)) revert UnknownMarket();
        return _markets[marketId];
    }

    function getPools(uint256 marketId) external view returns (PoolKey[] memory) {
        return _pools[marketId];
    }

    // ── Admin (affects new markets only) ────────────────────────────────────────

    function setParams(uint16 protocolFeeBps_, uint256 creationFee_, uint256 defaultBond_) external onlyOwner {
        if (protocolFeeBps_ > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh();
        protocolFeeBps = protocolFeeBps_;
        creationFee = creationFee_;
        defaultBond = defaultBond_;
        emit ParamsUpdated(protocolFeeBps_, creationFee_, defaultBond_);
    }

    /// @notice The deposit cap for markets created from now on (live markets keep theirs).
    function setDepositCap(uint256 cap) external onlyOwner {
        depositCap = cap;
        emit DepositCapSet(cap);
    }

    function setCreationPaused(bool paused) external onlyOwner {
        creationPaused = paused;
        emit CreationPaused(paused);
    }
}
