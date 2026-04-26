// scripts/get-tick-from-npm.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const NPM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);

const npm = new ethers.Contract(NPM, [
  "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
], provider);

async function main() {
  // Get position 2894209
  const tokenId = 2894209;
  const pos = await npm.positions(tokenId);
  
  console.log("=== Posição NFT 2894209 ===");
  console.log("tickLower:", pos[5].toString());
  console.log("tickUpper:", pos[6].toString());
  console.log("liquidity:", pos[7].toString());
  
  // Get feeGrowthInside to calculate current position value
  const feeGrowthInside0 = pos[8];
  const feeGrowthInside1 = pos[9];
  const tokensOwed0 = pos[10];
  const tokensOwed1 = pos[11];
  
  console.log("\n=== Fees ===");
  console.log("tokensOwed0 (WMATIC):", tokensOwed0.toString());
  console.log("tokensOwed1 (USDC):", tokensOwed1.toString());
  
  // Calculate prices from ticks
  const tickLower = Number(pos[5]);
  const tickUpper = Number(pos[6]);
  
  const priceLower = 1.0001 ** tickLower;
  const priceUpper = 1.0001 ** tickUpper;
  
  console.log("\n=== Range Prices ===");
  console.log("tickLower:", tickLower, "→ price:", priceLower.toFixed(6), "USDC/WMATIC");
  console.log("tickUpper:", tickUpper, "→ price:", priceUpper.toFixed(6), "USDC/WMATIC");
  
  // If we know the current price from user input (0.09131), check if in range
  const currentPrice = 0.09131;
  console.log("\n=== Current Price Check ===");
  console.log("Current price (from user):", currentPrice);
  console.log("Range:", priceLower.toFixed(6), "–", priceUpper.toFixed(6));
  
  if (currentPrice >= priceLower && currentPrice <= priceUpper) {
    console.log("\n✅ WITHIN RANGE!");
  } else {
    console.log("\n❌ OUT OF RANGE!");
    if (currentPrice < priceLower) {
      console.log("   Preço abaixo do range - precisa subir");
    } else {
      console.log("   Preço acima do range - precisa descer");
    }
  }
}

main();