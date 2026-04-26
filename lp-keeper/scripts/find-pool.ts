// scripts/find-pool.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const NPM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);

const npm = new ethers.Contract(NPM, [
  "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
  "function factory() view returns (address)",
], provider);

async function main() {
  // Get position 2894209 to find the pool
  const pos = await npm.positions(2894209);
  
  console.log("=== Posição 2894209 ===");
  console.log("token0:", pos[2]);
  console.log("token1:", pos[3]);
  console.log("fee:", pos[4].toString());
  console.log("tickLower:", pos[5].toString());
  console.log("tickUpper:", pos[6].toString());
  
  // Get factory to find pool
  const factory = await npm.factory();
  console.log("\nfactory:", factory);
  
  // For WMATIC/USDC 0.05%, we need to find the pool address
  // The pool is created by factory with the token pair and fee
}

main();