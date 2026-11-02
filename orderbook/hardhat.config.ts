import { defineConfig } from "hardhat/config";

export default defineConfig({
  solidity: {
    version: "0.8.26",
    settings: { viaIR: true, optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  paths: { sources: "src", tests: { solidity: "test" } },
});
