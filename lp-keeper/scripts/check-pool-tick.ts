// scripts/check-pool-tick.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// Pool address for WMATIC/USDC 0.05%
const POOL = "0xA374094527E1673A86dE62589Dc3cF3c8dF46B8";
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);

async function main() {
  // Call slot0() directly via RPC
  const slot0Data = await provider.call({
    to: POOL,
    data: "0x6c8f5c8a" // slot0() function selector
  });
  
  console.log("slot0 raw:", slot0Data);
  
  // Decode the result
  if (slot0Data && slot0Data !== "0x") {
    const result = ethers.AbiCoder.defaultAbiCoder().decode(
      ["int24", "uint160", "uint8", "bool", "int24", "uint16", "uint16", "uint32", "bool"],
      slot0Data
    );
    
    const tick = result[0];
    const sqrtPriceX96 = result[1];
    
    console.log("tick:", tick.toString());
    console.log("sqrtPriceX96:", sqrtPriceX96.toString());
    
    // Calculate price from sqrtPriceX96
    // price = (sqrtPriceX96 / 2^96)^2
    const sqrtPrice = Number(sqrtPriceX96) / (2 ** 96);
    const price = sqrtPrice * sqrtPrice;
    
    // For WMATIC/USDC, this gives price in USDC per WMATIC
    console.log("Price (USDC/WMATIC):", price.toFixed(8));
    
    // Check range
    const tickLower = 250750;
    const tickUpper = 253780;
    
    console.log("\n=== Range Analysis ===");
    console.log("tickLower:", tickLower);
    console.log("tickUpper:", tickUpper);
    console.log("currentTick:", tick.toString());
    
    if (Number(tick) >= tickLower && Number(tick) <= tickUpper) {
      console.log("\n✅ WITHIN RANGE!");
    } else {
      console.log("\n❌ OUT OF RANGE!");
    }
  }
}

main();