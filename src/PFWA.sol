// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PFWAMarketFactory} from "./PFWAMarketFactory.sol";

/// @title PFWA Oracle Orchestrator
/// @notice This contract acts as the relayer-authorized creator and resolver
///         for the automated recurring markets (Checkpoints and Listings)
///         using the PFWAMarketFactory bonding curve system.
contract PFWA is Ownable {
    
    PFWAMarketFactory public factory;
    address public relayer;

    // dayId => array of marketIds
    mapping(uint256 => uint256[]) public dailyMarkets;

    // listingId => marketId for Purchaser Keep NFT vs Take ETH
    mapping(uint256 => uint256) public listingMarkets;

    uint256 public currentDayId = 1;

    event FactorySet(address indexed factory);
    event RelayerSet(address indexed relayer);
    
    event DailyMarketsBatchCreated(uint256 indexed dayId, uint256 count);
    event DailyMarketsBatchResolved(uint256 indexed dayId);
    
    event ListingMarketCreated(uint256 indexed listingId, uint256 marketId);
    event ListingMarketResolved(uint256 indexed listingId, uint256 winningIndex);

    error OnlyRelayer();
    error InvalidFactory();

    modifier onlyRelayer() {
        if (msg.sender != relayer && msg.sender != owner()) revert OnlyRelayer();
        _;
    }

    constructor(address _factory, address _relayer) Ownable(msg.sender) {
        factory = PFWAMarketFactory(payable(_factory));
        relayer = _relayer;
    }

    function setFactory(address _factory) external onlyOwner {
        factory = PFWAMarketFactory(payable(_factory));
        emit FactorySet(_factory);
    }

    function setRelayer(address _relayer) external onlyOwner {
        relayer = _relayer;
        emit RelayerSet(_relayer);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CHECKPOINT MARKETS (Daily Protocol Fees, Purchases, Collections, Crown)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Create an automated batch of daily markets for a new day.
    function createDailyCheckpoints(
        uint256 dayId,
        uint256 expirationTime,
        string[] calldata titles,
        string[][] calldata options,
        PFWAMarketFactory.MarketType[] calldata marketTypes
    ) external onlyRelayer {
        require(dayId == currentDayId, "Must create for current day");
        require(titles.length == options.length && titles.length == marketTypes.length, "Length mismatch");

        for (uint i = 0; i < titles.length; i++) {
            (uint256 id, ) = factory.createRelayerMarket(titles[i], options[i], expirationTime, marketTypes[i]);
            dailyMarkets[dayId].push(id);
        }

        currentDayId++;
        emit DailyMarketsBatchCreated(dayId, titles.length);
    }

    /// @notice Resolve the automated daily markets for a past day.
    function resolveDailyCheckpoints(
        uint256 dayId,
        uint256[] calldata winningIndices
    ) external onlyRelayer {
        uint256[] memory markets = dailyMarkets[dayId];
        require(markets.length == winningIndices.length, "Length mismatch");

        for (uint i = 0; i < markets.length; i++) {
            factory.resolveMarket(markets[i], winningIndices[i]);
        }
        
        emit DailyMarketsBatchResolved(dayId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LISTING MARKETS (Keep NFT vs Take ETH)
    // ─────────────────────────────────────────────────────────────────────────

    function createListingMarket(uint256 listingId, uint256 expirationTime) external onlyRelayer {
        string[] memory options = new string[](2);
        options[0] = "Keep NFT";
        options[1] = "Take ETH";

        string memory name = string.concat("Listing #", _uint2str(listingId), " - Purchaser Decision");
        (uint256 marketId, ) = factory.createRelayerMarket(name, options, expirationTime, PFWAMarketFactory.MarketType.BINARY);
        
        listingMarkets[listingId] = marketId;
        emit ListingMarketCreated(listingId, marketId);
    }

    function resolveListingMarket(uint256 listingId, uint256 winningIndex) external onlyRelayer {
        factory.resolveMarket(listingMarkets[listingId], winningIndex);
        emit ListingMarketResolved(listingId, winningIndex);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UTIL
    // ─────────────────────────────────────────────────────────────────────────

    function _uint2str(uint256 _i) internal pure returns (string memory _uintAsString) {
        if (_i == 0) {
            return "0";
        }
        uint256 j = _i;
        uint256 len;
        while (j != 0) {
            len++;
            j /= 10;
        }
        bytes memory bstr = new bytes(len);
        uint256 k = len;
        while (_i != 0) {
            k = k - 1;
            uint8 temp = (48 + uint8(_i - (_i / 10) * 10));
            bytes1 b1 = bytes1(temp);
            bstr[k] = b1;
            _i /= 10;
        }
        return string(bstr);
    }
}
