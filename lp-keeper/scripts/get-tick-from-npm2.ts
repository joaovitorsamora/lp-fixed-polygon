// scripts/get-tick-from-npm2.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const NPM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);

const npm = new ethers.Contract(NPM, [
  "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
], provider);

async function main() {
  const tokenId = 2894209;
  const pos = await npm.positions(tokenId);
  
  const tickLower = Number(pos[5]);
  const tickUpper = Number(pos[6]);
  
  console.log("=== Posição NFT 2894209 ===");
  console.log("tickLower (raw):", tickLower);
  console.log("tickUpper (raw):", tickUpper);
  
  // Na Uniswap V3, o tickSpacing para fee 0.05% é 60
  // O tick real = rawTick / tickSpacing
  const tickSpacing = 60;
  const realTickLower = Math.floor(tickLower / tickSpacing);
  const realTickUpper = Math.floor(tickUpper / tickSpacing);
  
  console.log("tickLower (real):", realTickLower);
  console.log("tickUpper (real):", realTickUpper);
  
  // Calcular preços
  // price = 1.0001^tick (onde 1.0001 = (1.0005)^(1/60))
  const priceLower = 1.0001 ** realTickLower;
  const priceUpper = 1.0001 ** realTickUpper;
  
  console.log("\n=== Range Prices (USDC/WMATIC) ===");
  console.log("Lower:", priceLower.toFixed(6));
  console.log("Upper:", priceUpper.toFixed(6));
  
  // O preço atual informado pelo usuário
  const currentPrice = 0.09131;
  
  console.log("\n=== Current Price Check ===");
  console.log("Current:", currentPrice);
  console.log("Range:", priceLower.toFixed(6), "–", priceUpper.toFixed(6));
  
  if (currentPrice >= priceLower && currentPrice <= priceUpper) {
    console.log("\n✅ WITHIN RANGE!");
  } else {
    console.log("\n❌ OUT OF RANGE!");
  }
  
  // Também verificar o tick atual a partir do preço
  const tickFromPrice = Math.floor(Math.log(currentPrice) / Math.log(1.0001));
  console.log("\n=== Tick from current price ===");
  console.log("Calculated tick:", tickFromPrice);
  console.log("Raw tick:", tickFromPrice * tickSpacing);
}

main();