require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
const accounts = process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [];
module.exports = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 400 }, evmVersion: "cancun" } },
  networks: {
    localhost: { url: "http://127.0.0.1:8545" },
    rhTestnet: { url: "https://rpc.testnet.chain.robinhood.com", chainId: 46630, accounts },
    rhMainnet: { url: "https://rpc.mainnet.chain.robinhood.com", chainId: 4663, accounts },
  },
};
