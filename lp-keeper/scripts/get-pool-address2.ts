// scripts/get-pool-address2.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);

const factory = new ethers.Contract(FACTORY, [
  "function getPool(address,address,uint24) view returns (address)",
], provider);

async function main() {
  const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
  const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
  const fee = 500;
  
  // Get pool address
  const pool = await factory.getPool(WMATIC, USDC, fee);
  console.log("Pool address:", pool);
  
  // Call slot0 directly via RPC
  const slot0Data = await provider.call({
    to: pool,
    data: "0x6c8f5c8a"
  });
  
  console.log("slot0 raw:", slot0Data);
  
  if (slot0Data && slot0Data !== "0x") {
    // Parse the data manually
    // slot0 returns: (sqrtPriceX96, tick, observationIndex, initialized, tickSpacing, feeProtocol, unlocked)
    const hex = slot0Data.slice(2);
    
    // sqrtPriceX96 is uint160 - 40 hex chars (20 bytes)
    const sqrtHex = "0x" + hex.slice(0, 40);
    const sqrtPriceX96 = BigInt(sqrtHex);
    
    // tick is int24 - 8 hex chars (4 bytes), but may be negative
    const tickHex = "0x" + hex.slice(40, 48);
    let tick = parseInt(tickHex.slice(2), 16);
    // Handle negative tick (two's complement for signed int24)
    if (tick > 0x7FFFFF) {
      tick = tick - 0x1000000;
    }
    
    console.log("\n=== Pool Data ===");
    console.log("tick:", tick);
    console.log("sqrtPriceX96:", sqrtPriceX96.toString());
    
    // Calculate price
    const Q96 = 2n ** 96n;
    const sqrtNum = sqrtPriceX96 * sqrtPriceX96;
    const priceRaw = Number(sqrtNum) / Number(Q96);
    const price = priceRaw / 1e18;
    
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
      if (tick < tickLower) {
        console.log("   Preço abaixo do tickLower - precisa subir");
      } else {
        console.log("   Preço acima do tickUpper - precisa descer");
      }
    }
  }
}

main();