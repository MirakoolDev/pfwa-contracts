// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BondingCurveToken} from "../src/BondingCurveToken.sol";
import {PFWAMarketFactory} from "../src/PFWAMarketFactory.sol";

contract DeployPFWAMarkets is Script {
    function run() external {
        // Load deployment configuration from environment variables
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address platformAddress = vm.envAddress("PLATFORM_ADDRESS");
        address relayerAddress = vm.envAddress("RELAYER_ADDRESS");

        // Start broadcasting transactions
        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy the Logic Contract (BondingCurveToken)
        // This is the implementation that will be cloned for every market option.
        BondingCurveToken implementation = new BondingCurveToken();
        console2.log("BondingCurveToken Implementation deployed at:", address(implementation));

        // 2. Deploy the Market Factory
        PFWAMarketFactory factory = new PFWAMarketFactory(
            address(implementation),
            platformAddress,
            relayerAddress
        );
        console2.log("PFWAMarketFactory deployed at:", address(factory));

        vm.stopBroadcast();
    }
}
