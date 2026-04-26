// scripts/check-pool-price.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const POOL = "0xA374094527E1673A86dE62589Dc3cF3c8dF46B8"; // WMATIC/USDC 0.05%
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

const pool = new ethers.Contract(POOL, [
  "function slot0() view returns (int24,uint160,uint8,bool,int24,uint16,uint16,uint32,bool)",
], provider);

async function main() {
  const [tick, sqrtPriceX96] = await pool.slot0();
  console.log("tick:", tick.toString());
  console.log("sqrtPriceX96:", sqrtPriceX96.toString());
  
  // Calcular preço
  const price = Number((sqrtPriceX96 ** 2n) / 2n ** 192n) / 1e12;
  console.log("Preço (USDC/WMATIC):", price.toFixed(8));
}

main();