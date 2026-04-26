// scripts/get-pool-address.ts
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
  
  // Now get slot0
  const poolContract = new ethers.Contract(pool, [
    "function slot0() view returns (int24,uint160,uint8,bool,int24,uint16,uint16,uint32,bool)",
  ], provider);
  
  const [tick, sqrtPriceX96] = await poolContract.slot0();
  console.log("\ntick:", tick.toString());
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
  console.log("currentTick:", tick.toString());
  
  if (Number(tick) >= tickLower && Number(tick) <= tickUpper) {
    console.log("\n✅ WITHIN RANGE!");
  } else {
    console.log("\n❌ OUT OF RANGE!");
    if (Number(tick) < tickLower) {
      console.log("   Preço abaixo do tickLower");
    } else {
      console.log("   Preço acima do tickUpper");
    }
  }
}

main();