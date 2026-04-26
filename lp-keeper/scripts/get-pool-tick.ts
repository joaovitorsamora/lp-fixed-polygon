// scripts/get-pool-tick.ts
import dotenv from "dotenv";
dotenv.config();

const RPC_URL = process.env.RPC_URL!;

async function main() {
  // Direct HTTP request to RPC
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_call",
      params: [{
        to: "0xA374094527E1673A86dE62589Dc3cF3c8dF46B8",
        data: "0x6c8f5c8a"
      }, "latest"],
      id: 1
    })
  });
  
  const data = await response.json() as { result?: string };
  console.log("RPC Response:", JSON.stringify(data, null, 2));
  
  if (data.result) {
    const result = data.result;
    // Parse: tick (int24) starts at byte 0, sqrtPriceX96 (uint160) starts at byte 32
    const hex = result.slice(2);
    
    // tick is first 4 bytes (signed int24)
    const tickBytes = "0x" + hex.slice(0, 8);
    const tick = parseInt(tickBytes, 16);
    // Handle negative tick (two's complement for signed int24)
    const actualTick = tick > 0x7FFFFF ? tick - 0x1000000 : tick;
    
    // sqrtPriceX96 is next 20 bytes (40 hex chars)
    const sqrtBytes = "0x" + hex.slice(8, 48);
    const sqrtPriceX96 = BigInt(sqrtBytes);
    
    console.log("\n=== Pool Data ===");
    console.log("tick:", actualTick);
    console.log("sqrtPriceX96:", sqrtPriceX96.toString());
    
    // Calculate price: (sqrtPriceX96 / 2^96)^2
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
    console.log("currentTick:", actualTick);
    
    if (actualTick >= tickLower && actualTick <= tickUpper) {
      console.log("\n✅ WITHIN RANGE!");
    } else {
      console.log("\n❌ OUT OF RANGE!");
      if (actualTick < tickLower) {
        console.log("   Preço abaixo do tickLower - precisa subir");
      } else {
        console.log("   Preço acima do tickUpper - precisa descer");
      }
    }
  }
}

main();