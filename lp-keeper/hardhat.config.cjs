require("@nomicfoundation/hardhat-ethers");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    // ── Local ──────────────────────────────────────────────────────────────
    // hardhat:   { chainId: 31337 },
    // localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },

    // ── Polygon Amoy Testnet — testar antes da mainnet ────────────────────
    // Faucet gratuito: https://faucet.polygon.technology
    polygonAmoy: {
      url:      process.env.AMOY_RPC_URL ?? "https://rpc-amoy.polygon.technology",
      chainId:  80002,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: "auto",
    },

    // ── Polygon Mainnet ────────────────────────────────────────────────────
    // Requer POL para gas. Saldo atual: ~7.5 POL
    // RPC gratuito: https://polygon-rpc.com
    // RPC Alchemy:  https://polygon-mainnet.g.alchemy.com/v2/SUA_CHAVE
    polygon: {
      url:      process.env.RPC_URL ?? "https://polygon-mainnet.infura.io/v3/cdea87ca66e740f7bda1653681eb833c",
      chainId:  137,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: "auto",
    },
  },
};
