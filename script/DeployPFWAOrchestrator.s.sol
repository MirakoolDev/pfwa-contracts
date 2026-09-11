// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PFWA} from "../src/PFWA.sol";
import {PFWAMarketFactory} from "../src/PFWAMarketFactory.sol";

contract DeployPFWAOrchestrator is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address factoryAddress = vm.envAddress("FACTORY_ADDRESS");
        address relayerAddress = vm.envAddress("RELAYER_ADDRESS"); // The Node.js cron wallet

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy the new generalized PFWA Orchestrator, linked to the existing factory
        //    and the relayer (the wallet that calls createDailyCheckpoints)
        PFWA orchestrator = new PFWA(factoryAddress, relayerAddress);
        console2.log("New PFWA Orchestrator deployed at:", address(orchestrator));
        console2.log("Linked to Factory:", factoryAddress);
        console2.log("Set Relayer to:", relayerAddress);

        // 2. Update the Factory to recognize this new Orchestrator as its relayer
        PFWAMarketFactory factory = PFWAMarketFactory(payable(factoryAddress));
        factory.setRelayer(address(orchestrator));
        console2.log("Factory Relayer updated to the new Orchestrator!");

        vm.stopBroadcast();
    }
}
