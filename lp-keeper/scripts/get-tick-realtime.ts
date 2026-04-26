// scripts/get-tick-realtime.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);

async function main() {
  // Tentar múltiplos pools conhecidos de WMATIC/USDC 0.05%
  const pools = [
    "0xB6e57ed85c4c9dbfEF2a68711e9d6f36c56e0FcB", // Do factory
    "0xA374094527E1673A86dE62589Dc3cF3c8dF46B8", // Do arquivo anterior
  ];

  for (const pool of pools) {
    try {
      console.log(`\n=== Tentando pool: ${pool} ===`);
      
      // Call slot0 via low-level call
      const result = await provider.call({
        to: pool,
        data: "0x6c8f5c8a" // slot0()
      });
      
      if (result && result !== "0x") {
        console.log("✅ Resultado obtido!");
        console.log("Raw:", result);
        
        // Parse manually
        const hex = result.slice(2);
        
        // sqrtPriceX96 - 40 hex chars (uint160)
        const sqrtHex = "0x" + hex.slice(0, 40);
        const sqrtPriceX96 = BigInt(sqrtHex);
        
        // tick - 8 hex chars (int24)
        const tickHex = "0x" + hex.slice(40, 48);
        let tick = parseInt(tickHex.slice(2), 16);
        if (tick > 0x7FFFFF) tick = tick - 0x1000000;
        
        console.log("tick:", tick);
        console.log("sqrtPriceX96:", sqrtPriceX96.toString());
        
        // Calculate price
        const Q96 = 2n ** 96n;
        const priceRaw = Number(sqrtPriceX96 * sqrtPriceX96) / Number(Q96);
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
        }
        
        break;
      }
    } catch (e: any) {
      console.log("❌ Erro:", e.message?.slice(0, 100) || e);
    }
  }
}

main();