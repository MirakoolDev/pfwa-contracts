// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPFWAMarketFactory {
    function addBonusToPot(uint256 marketId) external payable;
    function postExpirationGrace() external view returns (uint256);
}

/// @title BondingCurveToken
/// @notice ERC20 token backed by a linear bonding curve.
/// @dev Deployed as a Minimal Proxy (EIP-1167 Clone) by PFWAMarketFactory.
///      Uses a Fixed Redemption Phase upon market resolution to guarantee fair
///      payouts regardless of when a winner claims their winnings.
contract BondingCurveToken is
    Initializable,
    ERC20Upgradeable,
    OwnableUpgradeable,
    ReentrancyGuard
{
    // ─────────────────────────────────────────────────────────────────────────
    // Immutable-like state (set once in initialize)
    // ─────────────────────────────────────────────────────────────────────────

    address public marketFactory;
    uint256 public marketId;
    uint256 public optionId;
    uint256 public expirationTime;

    address public creator;
    address public platform;

    // ─────────────────────────────────────────────────────────────────────────
    // Bonding Curve Parameters
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Price floor — cost of the very first token.
    uint256 public basePrice;

    /// @notice Rate at which price rises per token minted (wei per token).
    uint256 public slope;

    /// @notice Fee split to creator and platform on each buy/sell (per 1000).
    uint256 public feePercentage;
    uint256 public sellFeePercentage;

    // ─────────────────────────────────────────────────────────────────────────
    // Market State
    // ─────────────────────────────────────────────────────────────────────────

    bool public tradingPaused;
    bool public marketResolved;

    /// @notice Set to nonzero by resolveMarket when this is the WINNING token.
    ///         Represents ETH per token (scaled by 1e18).
    uint256 public fixedRedemptionPrice;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event TokensBought(uint256 indexed marketId, uint256 indexed optionId, address indexed buyer, uint256 ethPaid, uint256 tokenAmount);
    event TokensSold(uint256 indexed marketId, uint256 indexed optionId, address indexed seller, uint256 ethReceived, uint256 tokenAmount);
    event WinningsClaimed(uint256 indexed marketId, uint256 indexed optionId, address indexed claimant, uint256 ethReceived, uint256 tokensBurned);
    event MarketResolved(uint256 indexed marketId, uint256 indexed optionId, bool isWinner, uint256 redemptionPrice);
    event PriceSnapshot(uint256 indexed marketId, uint256 indexed optionId, uint256 timestamp, uint256 spotPrice);
    event TradingPaused(uint256 indexed marketId, uint256 indexed optionId);
    event TradingResumed(uint256 indexed marketId, uint256 indexed optionId);
    event FeeDistributed(uint256 indexed marketId, uint256 indexed optionId, uint256 creatorFee, uint256 platformFee, string action);

    // ─────────────────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────────────────

    modifier onlyFactory() {
        require(msg.sender == marketFactory, "BCT: caller is not the factory");
        _;
    }

    modifier tradingActive() {
        require(!tradingPaused, "BCT: trading is paused");
        require(!marketResolved, "BCT: market is resolved, use claimWinnings");
        
        uint256 grace = IPFWAMarketFactory(marketFactory).postExpirationGrace();
        bool isPhase1 = block.timestamp < expirationTime;
        bool isPhase3 = block.timestamp >= expirationTime + grace;
        require(isPhase1 || isPhase3, "BCT: trading is paused during grace period");
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Initializer (replaces constructor for proxy pattern)
    // ─────────────────────────────────────────────────────────────────────────

    /// @param _factory       The PFWAMarketFactory that deployed this clone.
    /// @param _name          ERC20 token name (e.g. "Keep", "Yes").
    /// @param _symbol        ERC20 token symbol.
    /// @param _expirationTime Unix timestamp when trading ends.
    /// @param _marketId      Parent market ID in the factory.
    /// @param _optionId      Index of this option within the market.
    /// @param _creator       Market creator — receives half of all fees.
    struct InitParams {
        address factory;
        string name;
        string symbol;
        uint256 expirationTime;
        uint256 marketId;
        uint256 optionId;
        address creator;
        address platform;
        uint256 basePrice;
        uint256 slope;
        uint256 feePercentage;
        uint256 sellFeePercentage;
    }

    function initialize(InitParams memory params) external initializer {
        __ERC20_init(params.name, params.symbol);
        __Ownable_init(params.factory);

        marketFactory = params.factory;
        expirationTime = params.expirationTime;
        marketId = params.marketId;
        optionId = params.optionId;
        creator = params.creator;
        platform = params.platform;
        basePrice = params.basePrice;
        slope = params.slope;
        feePercentage = params.feePercentage;
        sellFeePercentage = params.sellFeePercentage;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Bonding Curve Math
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Spot price at a given supply level.
    function spotPrice(uint256 supply) public view returns (uint256) {
        return basePrice + (slope * supply) / 1e18;
    }

    /// @notice Total ETH cost to buy `tokenAmount` tokens at current supply (before fee).
    function costToBuy(uint256 tokenAmount) public view returns (uint256) {
        uint256 supply = totalSupply();
        // Integral of (basePrice + slope*s/1e18) from supply to supply+tokenAmount
        uint256 base = (basePrice * tokenAmount) / 1e18;
        uint256 inc  = (slope * ((tokenAmount * supply / 1e18) + (tokenAmount * tokenAmount / (2 * 1e18)))) / 1e18;
        return base + inc;
    }

    /// @notice Total ETH proceeds from selling `tokenAmount` tokens (before fee).
    function proceedsFromSell(uint256 tokenAmount) public view returns (uint256) {
        uint256 supply = totalSupply();
        require(tokenAmount <= supply, "BCT: amount exceeds supply");
        uint256 supplyAfter = supply - tokenAmount;
        uint256 base = (basePrice * tokenAmount) / 1e18;
        uint256 inc  = (slope * ((tokenAmount * supplyAfter / 1e18) + (tokenAmount * tokenAmount / (2 * 1e18)))) / 1e18;
        return base + inc;
    }

    /// @notice ETH cost including fees for a given token amount to buy.
    function costToBuyWithFee(uint256 tokenAmount) public view returns (uint256) {
        uint256 raw = costToBuy(tokenAmount);
        uint256 fee = (raw * 2 * feePercentage) / 1000;
        return raw + fee;
    }

    /// @notice Token amount you would receive for a given ETH amount (inverse).
    function tokensForEth(uint256 ethAmount) public view returns (uint256) {
        if (ethAmount == 0) return 0;
        // Solve quadratic: slope/2 * t^2 + (slope*supply + basePrice*1e18) * t - ethAmount*1e18^2 = 0
        uint256 supply = totalSupply();
        uint256 a = slope / 2;
        uint256 b = (slope * supply / 1e18) + basePrice;
        uint256 c = ethAmount;
        uint256 disc = b * b + 4 * a * c;
        uint256 sqrtDisc = _sqrt(disc);
        require(sqrtDisc >= b, "BCT: no solution");
        return ((sqrtDisc - b) * 1e18) / (2 * a);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // User-Facing Trading
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Buy tokens on the bonding curve. Overpayment is refunded.
    function buy(uint256 tokenAmount) external payable nonReentrant tradingActive {
        require(tokenAmount > 0, "BCT: zero amount");
        uint256 rawCost = costToBuy(tokenAmount);
        uint256 creatorFee = (rawCost * feePercentage) / 1000;
        uint256 platformFee = (rawCost * feePercentage) / 1000;
        uint256 totalCost = rawCost + creatorFee + platformFee;

        require(msg.value >= totalCost, "BCT: insufficient payment");

        _mint(msg.sender, tokenAmount);

        // Refund excess
        if (msg.value > totalCost) {
            (bool refundOk, ) = msg.sender.call{value: msg.value - totalCost}("");
            require(refundOk, "BCT: refund failed");
        }

        // Use call to prevent DoS if creator/platform is an unpayable contract
        (bool cOk, ) = creator.call{value: creatorFee}("");
        cOk;
        (bool pOk, ) = platform.call{value: platformFee}("");
        pOk;
        // We don't require() these to succeed to prevent malicious creators from halting trading
        // If they fail, the ETH just stays in the contract (safe fallback)

        emit TokensBought(marketId, optionId, msg.sender, rawCost, tokenAmount);
        emit PriceSnapshot(marketId, optionId, block.timestamp, spotPrice(totalSupply()));
        emit FeeDistributed(marketId, optionId, creatorFee, platformFee, "buy");
    }

    /// @notice Sell tokens back to the bonding curve reserve.
    function sell(uint256 tokenAmount) external nonReentrant tradingActive returns (uint256) {
        require(tokenAmount > 0, "BCT: zero amount");
        require(balanceOf(msg.sender) >= tokenAmount, "BCT: insufficient balance");

        uint256 rawProceeds = proceedsFromSell(tokenAmount);
        require(address(this).balance >= rawProceeds, "BCT: reserve insufficient");

        _burn(msg.sender, tokenAmount);

        uint256 userPayout;
        {
            uint256 platformShare;
            uint256 creatorShare;
            uint256 bonusPotShare;

            if (block.timestamp < expirationTime) {
                // Early dumper penalty (e.g. 10%)
                uint256 penalty = (rawProceeds * sellFeePercentage) / 1000;
                platformShare = penalty / 2;
                bonusPotShare = penalty - platformShare;
                userPayout = rawProceeds - penalty;
            } else {
                // Post-expiration normal fee (matches buy fee structure)
                creatorShare = (rawProceeds * feePercentage) / 1000;
                platformShare = (rawProceeds * feePercentage) / 1000;
                userPayout = rawProceeds - creatorShare - platformShare;
            }

            (bool uOk, ) = msg.sender.call{value: userPayout}("");
            require(uOk, "BCT: user payout failed");
            
            if (platformShare > 0) {
                (bool pOk, ) = platform.call{value: platformShare}("");
                pOk;
            }
            if (creatorShare > 0) {
                (bool cOk, ) = creator.call{value: creatorShare}("");
                cOk;
            }
            if (bonusPotShare > 0) {
                IPFWAMarketFactory(marketFactory).addBonusToPot{value: bonusPotShare}(marketId);
            }
        }

        emit TokensSold(marketId, optionId, msg.sender, rawProceeds, tokenAmount);
        emit PriceSnapshot(marketId, optionId, block.timestamp, spotPrice(totalSupply()));

        return userPayout;
    }

    /// @notice Claim ETH winnings after market resolution.
    ///         Burns all caller's tokens and pays out at the fixedRedemptionPrice.
    ///         Safe to call at any time after resolution — payout is always equal.
    function claimWinnings() external nonReentrant {
        require(marketResolved, "BCT: market not resolved yet");
        require(fixedRedemptionPrice > 0, "BCT: this option lost or payout is zero");

        uint256 amount = balanceOf(msg.sender);
        require(amount > 0, "BCT: no tokens to claim");

        uint256 payout = (amount * fixedRedemptionPrice) / 1e18;
        require(address(this).balance >= payout, "BCT: reserve too low");

        _burn(msg.sender, amount);
        
        (bool ok, ) = msg.sender.call{value: payout}("");
        require(ok, "BCT: payout transfer failed");

        emit WinningsClaimed(marketId, optionId, msg.sender, payout, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Factory-Only Callbacks
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Called by the factory on resolution. Sets the fixed redemption price
    ///         for the winning token. Losing tokens receive price = 0.
    function setResolved(bool isWinner, uint256 redemptionPrice) external onlyFactory {
        marketResolved = true;
        if (isWinner) {
            fixedRedemptionPrice = redemptionPrice;
        }
        emit MarketResolved(marketId, optionId, isWinner, redemptionPrice);
        if (!isWinner) {
            emit PriceSnapshot(marketId, optionId, block.timestamp, 0);
        }
    }

    function pauseTrading() external onlyFactory {
        tradingPaused = true;
        emit TradingPaused(marketId, optionId);
    }

    function resumeTrading() external onlyFactory {
        tradingPaused = false;
        emit TradingResumed(marketId, optionId);
    }

    function setBasePrice(uint256 _basePrice) external onlyFactory { basePrice = _basePrice; }
    function setSlope(uint256 _slope) external onlyFactory { slope = _slope; }
    function setFeePercentage(uint256 _fee) external onlyFactory { feePercentage = _fee; }

    /// @notice Drain ETH from a losing token's reserve to the factory for redistribution.
    function drainToFactory(uint256 amount) external onlyFactory {
        require(amount <= address(this).balance, "BCT: insufficient balance");
        (bool tSuccess, ) = marketFactory.call{value: amount}("");
        require(tSuccess, "BCT: transfer to factory failed");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────

    function _sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    receive() external payable {}
}

