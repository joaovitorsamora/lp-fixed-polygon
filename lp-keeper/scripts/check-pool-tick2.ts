// scripts/check-pool-tick2.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const POOL = "0xA374094527E1673A86dE62589Dc3cF3c8dF46B8";
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);

async function main() {
  // Direct RPC call
  const response = await provider.send("eth_call", [{
    to: POOL,
    data: "0x6c8f5c8a" // slot0()
  }, "latest"]);
  
  console.log("Response:", response);
  
  if (response && response !== "0x") {
    // Parse manually - tick is at offset 0 (int24 = 32 bits)
    // sqrtPriceX96 at offset 32 (uint160 = 160 bits)
    const data = response.slice(2);
    const tickHex = "0x" + data.slice(0, 8); // First 4 bytes (int24)
    const sqrtHex = "0x" + data.slice(8, 48); // Next 20 bytes (uint160)
    
    const tick = parseInt(tickHex, 16);
    const sqrtPriceX96 = BigInt(sqrtHex);
    
    console.log("tick:", tick);
    console.log("sqrtPriceX96:", sqrtPriceX96.toString());
    
    // Calculate price
    const Q96 = 2n ** 96n;
    const priceRaw = (sqrtPriceX96 * sqrtPriceX96) / Q96;
    const price = Number(priceRaw) / 1e18;
    
    console.log("Price (USDC/WMATIC):", price.toFixed(8));
    
    // Check range
    const tickLower = 250750;
    const tickUpper = 253780;
    
    console.log("\n=== Range Analysis ===");
    console.log("tickLower:", tickLower);
    console.log("tickUpper:", tickUpper);
    console.log("currentTick:", tick);
    
    if (tick >= tickLower && tick <= tickUpper) {
      console.log("\n✅ WITHIN RANGE!");
    } else {
      console.log("\n❌ OUT OF RANGE!");
    }
  }
}

main();