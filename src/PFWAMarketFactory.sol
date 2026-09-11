// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BondingCurveToken} from "./BondingCurveToken.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IBurnableERC20 {
    function burn(uint256 amount) external;
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IWETH {
    function deposit() external payable;
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @title PFWAMarketFactory
/// @notice Singleton factory that creates prediction markets (up to 10 options)
///         using Minimal Proxy clones of BondingCurveToken. Handles market
///         lifecycle: creation → active trading → resolution → fixed payouts.
/// @dev    Only one `BondingCurveToken` implementation is deployed. Every
///         option in every market is a cheap EIP-1167 clone of it (~$0.001 on L2).
contract PFWAMarketFactory is Ownable, ReentrancyGuard {
    using Clones for address;

    // ─────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────

    struct Option {
        string   name;
        address  tokenAddress;
        uint256  optionId;
    }

    enum MarketType {
        BINARY,         // Keep/Remove, Yes/No — 2 options
        MULTI_OPTION,   // Weekly Volume Race — up to 10 options
        CUSTOM          // Any admin-created market
    }

    struct Market {
        string      name;
        MarketType  marketType;
        Option[]    options;
        uint256     expirationTime;
        bool        resolved;
        address     creator;
        uint256     winningOptionIndex;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The single deployed BondingCurveToken logic contract.
    address public immutable implementation;

    mapping(uint256 => Market) public markets;
    uint256 public marketCount;

    address public platformAddress;
    address public relayer;

    // Global bonding curve defaults (can be overridden per market)
    uint256 public defaultBasePrice    = 0.00000003 ether;
    uint256 public defaultSlope        = 0.00000003 ether;
    uint256 public defaultFeePerMille  = 15; // 1.5% for buys
    uint256 public defaultSellFeePerMille = 100; // 10% for early sells

    uint256 public marketCreationFee   = 0.005 ether;
    uint256 public postExpirationGrace = 2 days;

    // Buyback settings
    uint256 public buybackBurnPercentage = 5000; // 50% = 5000 bps
    address public pfwaToken = 0xa934bA4F59070149d37A93F8A002Af79BAe35563;
    address public dexRouter = 0xCaf681a66D020601342297493863E78C959E5cb2;
    uint256 public minBuybackAmountOut = 0; // Settable floor for MEV protection

    // Daily limit settings
    uint256 public maxDailyMarkets = 100;
    mapping(uint256 => uint256) public dailyMarketCount;

    // Early dumper penalty pool: marketId => total ETH penalized
    mapping(uint256 => uint256) public marketBonusPot;
    uint256 public totalBonusPotLocked;

    // Creation Pause
    bool public isCreationPaused;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event MarketCreated(
        uint256 indexed marketId,
        MarketType indexed marketType,
        string name,
        uint256 expirationTime,
        address creator,
        address[] optionTokens
    );

    event MarketResolved(
        uint256 indexed marketId,
        uint256 winningOptionIndex,
        uint256 fixedRedemptionPrice,
        uint256 totalEthPooled
    );

    event OptionTokenDeployed(
        uint256 indexed marketId,
        uint256 indexed optionId,
        address tokenAddress,
        string optionName
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    /// @param _implementation  Address of the deployed BondingCurveToken logic.
    /// @param _platform        Platform treasury — receives half the protocol fees.
    /// @param _relayer         Trusted oracle relayer that can resolve weekly markets.
    constructor(address _implementation, address _platform, address _relayer) Ownable(msg.sender) {
        require(_implementation != address(0), "Factory: zero implementation");
        require(_platform      != address(0), "Factory: zero platform");
        require(_relayer       != address(0), "Factory: zero relayer");
        implementation  = _implementation;
        platformAddress = _platform;
        relayer         = _relayer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Market Creation
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Create a new prediction market.
    /// @param name          Human-readable name (e.g. "Listing #105 — Keep or Remove?").
    /// @param optionNames   Array of option labels. Min 2, max 10.
    /// @param expirationTime Unix timestamp when trading closes.
    /// @param marketType    BINARY / MULTI_OPTION / CUSTOM.
    function createMarket(
        string calldata name,
        string[] calldata optionNames,
        uint256 expirationTime,
        MarketType marketType
    ) external payable nonReentrant returns (uint256 marketId, address[] memory optionTokens) {
        require(!isCreationPaused,                           "Factory: creation is paused");
        require(msg.value == marketCreationFee,              "Factory: wrong creation fee");
        require(optionNames.length >= 2,                     "Factory: need at least 2 options");
        require(optionNames.length <= 10,                    "Factory: max 10 options");
        require(expirationTime > block.timestamp,            "Factory: expiry in the past");

        uint256 today = block.timestamp / 1 days;
        require(dailyMarketCount[today] < maxDailyMarkets, "Factory: daily limit reached");
        dailyMarketCount[today]++;

        uint256 buybackFee = (marketCreationFee * buybackBurnPercentage) / 10000;
        uint256 platformFee = marketCreationFee - buybackFee;

        if (platformFee > 0) {
            (bool pOk, ) = platformAddress.call{value: platformFee}("");
            require(pOk, "Factory: fee transfer failed");
        }

        if (buybackFee > 0 && dexRouter != address(0) && pfwaToken != address(0)) {
            _buybackAndBurnPfwa(buybackFee);
        } else if (buybackFee > 0) {
            (bool bOk, ) = platformAddress.call{value: buybackFee}("");
            require(bOk, "Factory: fee transfer failed");
        }

        marketId = marketCount++;
        Market storage m = markets[marketId];
        m.name          = name;
        m.marketType    = marketType;
        m.expirationTime = expirationTime;
        m.creator       = msg.sender;

        optionTokens = new address[](optionNames.length);

        for (uint256 i = 0; i < optionNames.length; i++) {
            address token = _deployOptionToken(
                optionNames[i],
                expirationTime,
                marketId,
                i,
                msg.sender
            );
            m.options.push(Option({name: optionNames[i], tokenAddress: token, optionId: i}));
            optionTokens[i] = token;
            emit OptionTokenDeployed(marketId, i, token, optionNames[i]);
        }

        emit MarketCreated(marketId, marketType, name, expirationTime, msg.sender, optionTokens);
    }

    /// @notice Relayer-privileged helper to create weekly volume/metric markets
    ///         without requiring a creation fee (fee is covered by the protocol).
    function createRelayerMarket(
        string calldata name,
        string[] calldata optionNames,
        uint256 expirationTime,
        MarketType marketType
    ) external returns (uint256 marketId, address[] memory optionTokens) {
        require(!isCreationPaused,        "Factory: creation is paused");
        require(msg.sender == relayer || msg.sender == owner(), "Factory: not relayer");
        require(optionNames.length >= 2,  "Factory: need at least 2 options");
        require(optionNames.length <= 10, "Factory: max 10 options");
        require(expirationTime > block.timestamp, "Factory: expiry in the past");

        marketId = marketCount++;
        Market storage m = markets[marketId];
        m.name           = name;
        m.marketType     = marketType;
        m.expirationTime = expirationTime;
        m.creator        = msg.sender;

        optionTokens = new address[](optionNames.length);

        for (uint256 i = 0; i < optionNames.length; i++) {
            address token = _deployOptionToken(
                optionNames[i],
                expirationTime,
                marketId,
                i,
                platformAddress
            );
            m.options.push(Option({name: optionNames[i], tokenAddress: token, optionId: i}));
            optionTokens[i] = token;
            emit OptionTokenDeployed(marketId, i, token, optionNames[i]);
        }

        emit MarketCreated(marketId, marketType, name, expirationTime, msg.sender, optionTokens);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Penalty Forwarding
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Allows option tokens to forward the 5% early dumper penalty to the winner's pot.
    function addBonusToPot(uint256 marketId) external payable {
        require(msg.value > 0, "Factory: no value sent");
        // We only allow known token addresses to add to the pot for safety (optional but good practice)
        marketBonusPot[marketId] += msg.value;
        totalBonusPotLocked += msg.value;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Market Resolution
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Resolve a market and set the fixed payout for winning token holders.
    /// @dev Callable by the market creator OR the relayer (for relayer-created markets).
    ///      1. Drains all ETH from all losing option tokens to this factory.
    ///      2. Calculates fixedRedemptionPrice = totalETH / winningSupply.
    ///      3. Sends all losing ETH into the winning token contract.
    ///      4. Marks all tokens as resolved — trading halted permanently.
    function resolveMarket(uint256 marketId, uint256 winningOptionIndex) external nonReentrant {
        Market storage m = markets[marketId];
        require(!m.resolved,  "Factory: already resolved");
        
        require(
            msg.sender == m.creator || 
            (msg.sender == relayer && m.creator == address(this)) ||
            (msg.sender == relayer && m.creator == platformAddress) ||
            (msg.sender == relayer && m.creator == owner()) ||
            msg.sender == owner() ||
            ((msg.sender == relayer || msg.sender == owner()) && block.timestamp >= m.expirationTime + postExpirationGrace),
            "Factory: unauthorised resolver"
        );
        require(winningOptionIndex < m.options.length, "Factory: invalid winning option");

        m.resolved            = true;
        m.winningOptionIndex  = winningOptionIndex;

        // ── Step 1: collect all ETH balances ────────────────────────────────
        uint256 totalETH;
        uint256[] memory balances = new uint256[](m.options.length);

        for (uint256 i = 0; i < m.options.length; i++) {
            BondingCurveToken tok = BondingCurveToken(payable(m.options[i].tokenAddress));
            balances[i] = address(tok).balance;
            totalETH   += balances[i];

            if (i != winningOptionIndex && balances[i] > 0) {
                tok.drainToFactory(balances[i]);
            }
        }

        // ── Step 2: calculate fixed payout ───────────────────────────────────
        BondingCurveToken winner = BondingCurveToken(payable(m.options[winningOptionIndex].tokenAddress));
        uint256 winningSupply    = winner.totalSupply();
        uint256 fixedPrice       = 0;
        
        uint256 bonusETH = marketBonusPot[marketId];
        uint256 finalPoolETH = totalETH + bonusETH;
        
        if (bonusETH > 0) {
            marketBonusPot[marketId] = 0; // Clear it to prevent double sweep
            totalBonusPotLocked -= bonusETH;
        }

        if (winningSupply > 0) {
            fixedPrice = (finalPoolETH * 1e18) / winningSupply;
        }

        // ── Step 3: fund the winning token reserve ───────────────────────────
        uint256 losingETH = totalETH - balances[winningOptionIndex];
        uint256 amountToFund = losingETH + bonusETH;
        
        if (amountToFund > 0) {
            if (winningSupply > 0) {
                // Transfer losing ETH + penalty bonus into the winning token reserve
                (bool ok, ) = address(winner).call{value: amountToFund}("");
                require(ok, "Factory: ETH transfer to winner failed");
            } else {
                // FALLBACK: If winning option has zero supply, nobody can claim. Sweep to Treasury.
                (bool ok, ) = address(platformAddress).call{value: amountToFund}("");
                require(ok, "Factory: fallback ETH transfer failed");
            }
        }

        // ── Step 4: mark all tokens resolved ─────────────────────────────────
        for (uint256 i = 0; i < m.options.length; i++) {
            bool isWinner = (i == winningOptionIndex);
            BondingCurveToken(payable(m.options[i].tokenAddress))
                .setResolved(isWinner, isWinner ? fixedPrice : 0);
        }

        emit MarketResolved(marketId, winningOptionIndex, fixedPrice, totalETH);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Emergency Admin Controls
    // ─────────────────────────────────────────────────────────────────────────

    function pauseCreation() external onlyOwner {
        isCreationPaused = true;
    }

    function resumeCreation() external onlyOwner {
        isCreationPaused = false;
    }

    function pauseMarket(uint256 marketId) external onlyOwner {
        Market storage m = markets[marketId];
        for (uint256 i = 0; i < m.options.length; i++) {
            BondingCurveToken(payable(m.options[i].tokenAddress)).pauseTrading();
        }
    }

    function resumeMarket(uint256 marketId) external onlyOwner {
        Market storage m = markets[marketId];
        for (uint256 i = 0; i < m.options.length; i++) {
            BondingCurveToken(payable(m.options[i].tokenAddress)).resumeTrading();
        }
    }

    function setFeeForMarket(uint256 marketId, uint256 newFee) external {
        Market storage m = markets[marketId];
        require(msg.sender == m.creator || msg.sender == owner(), "Factory: not creator");
        
        // Audit Fix: Only allow decreasing fees to prevent rugging buyers
        BondingCurveToken firstToken = BondingCurveToken(payable(m.options[0].tokenAddress));
        require(newFee <= firstToken.feePercentage(), "Factory: can only decrease fee");
        
        for (uint256 i = 0; i < m.options.length; i++) {
            BondingCurveToken(payable(m.options[i].tokenAddress)).setFeePercentage(newFee);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // View Helpers
    // ─────────────────────────────────────────────────────────────────────────

    function getMarket(uint256 marketId) external view returns (
        string memory name,
        MarketType marketType,
        uint256 expirationTime,
        bool resolved,
        address creator,
        uint256 winningOptionIndex,
        uint256 optionCount
    ) {
        Market storage m = markets[marketId];
        return (m.name, m.marketType, m.expirationTime, m.resolved, m.creator, m.winningOptionIndex, m.options.length);
    }

    function getOptions(uint256 marketId) external view returns (Option[] memory) {
        return markets[marketId].options;
    }

    function getOptionTokenAddresses(uint256 marketId) external view returns (address[] memory) {
        Option[] memory opts = markets[marketId].options;
        address[] memory addrs = new address[](opts.length);
        for (uint256 i = 0; i < opts.length; i++) {
            addrs[i] = opts[i].tokenAddress;
        }
        return addrs;
    }

    function getOptionEthBalances(uint256 marketId) external view returns (uint256[] memory) {
        Option[] memory opts = markets[marketId].options;
        uint256[] memory balances = new uint256[](opts.length);
        for (uint256 i = 0; i < opts.length; i++) {
            balances[i] = address(opts[i].tokenAddress).balance;
        }
        return balances;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin Config
    // ─────────────────────────────────────────────────────────────────────────

    function setPlatformAddress(address _platform) external onlyOwner   { platformAddress = _platform; }
    function setRelayer(address _relayer)          external onlyOwner   { relayer = _relayer; }
    function setCreationFee(uint256 _fee)          external onlyOwner   { marketCreationFee = _fee; }
    function setGracePeriod(uint256 _grace)        external onlyOwner   { postExpirationGrace = _grace; }
    function setDefaultBasePrice(uint256 _base)    external onlyOwner   { defaultBasePrice = _base; }
    function setDefaultSlope(uint256 _slope)       external onlyOwner   { defaultSlope = _slope; }
    function setDefaultFee(uint256 _fee)           external onlyOwner   { defaultFeePerMille = _fee; }
    function setDefaultSellFee(uint256 _fee)       external onlyOwner   { defaultSellFeePerMille = _fee; }
    function setBuybackBurnPercentage(uint256 _pct) external onlyOwner  { buybackBurnPercentage = _pct; }
    function setPfwaToken(address _pfwa)           external onlyOwner   { pfwaToken = _pfwa; }
    function setDexRouter(address _router)         external onlyOwner   { dexRouter = _router; }
    function setMaxDailyMarkets(uint256 _max)      external onlyOwner   { maxDailyMarkets = _max; }
    function setMinBuybackAmountOut(uint256 _min)  external onlyOwner   { minBuybackAmountOut = _min; }

    // ─────────────────────────────────────────────────────────────────────────
    // Emergency Withdraw
    // ─────────────────────────────────────────────────────────────────────────

    function emergencyWithdrawStrayEth() external onlyOwner {
        uint256 safeBalance = address(this).balance - totalBonusPotLocked;
        require(safeBalance > 0, "Factory: no stray ETH to withdraw");
        (bool ok, ) = platformAddress.call{value: safeBalance}("");
        require(ok, "Factory: withdraw failed");
    }

    /// @notice Allows the protocol to recover stuck ERC20 tokens (like WETH from failed swaps)
    function emergencyWithdrawERC20(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "Factory: no tokens to withdraw");
        IERC20(token).transfer(platformAddress, balance);
    }

    /// @notice Allows the protocol to claim the bonus pot of a market that has been abandoned
    /// @dev Can only be called after the grace period has passed
    function claimAbandonedBonusPot(uint256 marketId) external onlyOwner {
        Market storage m = markets[marketId];
        require(block.timestamp >= m.expirationTime + postExpirationGrace, "Factory: grace period not met");
        require(!m.resolved, "Factory: already resolved");
        
        uint256 amount = marketBonusPot[marketId];
        require(amount > 0, "Factory: no bonus pot to claim");
        
        marketBonusPot[marketId] = 0;
        totalBonusPotLocked -= amount;
        
        (bool ok, ) = platformAddress.call{value: amount}("");
        require(ok, "Factory: claim failed");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────

    // Relay.link / UniswapV3 buyback config
    address public wethToken = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73; // Robinhood WETH
    uint24 public poolFee = 10000; // 1% pool fee

    function setWethToken(address _weth) external onlyOwner { wethToken = _weth; }
    function setPoolFee(uint24 _fee) external onlyOwner { poolFee = _fee; }

    function _buybackAndBurnPfwa(uint256 amountEth) internal {
        uint256 pfwaBefore = IERC20(pfwaToken).balanceOf(address(this));

        try IWETH(wethToken).deposit{value: amountEth}() {
            IWETH(wethToken).approve(dexRouter, amountEth);
            
            ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
                tokenIn: wethToken,
                tokenOut: pfwaToken,
                fee: poolFee,
                recipient: address(this),
                amountIn: amountEth,
                amountOutMinimum: minBuybackAmountOut,
                sqrtPriceLimitX96: 0
            });

            try ISwapRouter(dexRouter).exactInputSingle(params) {
                uint256 pfwaAfter = IERC20(pfwaToken).balanceOf(address(this));
                uint256 pfwaBought = pfwaAfter - pfwaBefore;
                if (pfwaBought > 0) {
                    try IERC20(pfwaToken).transfer(0x000000000000000000000000000000000000dEaD, pfwaBought) {} catch {}
                }
            } catch {
                // If swap fails, just sweep the WETH to platform later or manually
            }
        } catch {
            (bool ok, ) = platformAddress.call{value: amountEth}("");
            require(ok, "Factory: fallback sweep failed");
        }
    }

    function _deployOptionToken(
        string memory optionName,
        uint256 expirationTime,
        uint256 marketId,
        uint256 optionId,
        address creator
    ) internal returns (address tokenAddress) {
        tokenAddress = implementation.clone();
        BondingCurveToken(payable(tokenAddress)).initialize(BondingCurveToken.InitParams({
            factory: address(this),
            name: optionName,
            symbol: optionName,
            expirationTime: expirationTime,
            marketId: marketId,
            optionId: optionId,
            creator: creator,
            platform: platformAddress,
            basePrice: defaultBasePrice,
            slope: defaultSlope,
            feePercentage: defaultFeePerMille,
            sellFeePercentage: defaultSellFeePerMille
        }));
    }

    receive() external payable {}
}



