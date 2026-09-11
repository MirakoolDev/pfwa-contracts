// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal interface that PFWA.sol uses to call PFWAMarketFactory.
interface IPFWAMarketFactory {
    enum MarketType { BINARY, MULTI_OPTION, CUSTOM }

    function createRelayerMarket(
        string calldata name,
        string[] calldata optionNames,
        uint256 expirationTime,
        MarketType marketType
    ) external returns (uint256 marketId, address[] memory optionTokens);

    function resolveMarket(uint256 marketId, uint256 winningOptionIndex) external;

    function getOptionTokenAddresses(uint256 marketId) external view returns (address[] memory);
}
