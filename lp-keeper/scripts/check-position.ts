// scripts/check-position.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const NPM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

const npm = new ethers.Contract(NPM, [
  "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
], provider);

async function main() {
  const tokenId = 2894209;
  const pos = await npm.positions(tokenId);
  console.log("=== Posição NFT 2894209 ===");
  console.log("tickLower:", pos[5].toString());
  console.log("tickUpper:", pos[6].toString());
  console.log("liquidity:", pos[7].toString());
  
  // Calcular preços
  const tickMath = (tick: number) => 1.0001 ** tick;
  const priceLower = tickMath(Number(pos[5]));
  const priceUpper = tickMath(Number(pos[6]));
  console.log("Preço lower (USDC/WMATIC):", priceLower.toFixed(6));
  console.log("Preço upper (USDC/WMATIC):", priceUpper.toFixed(6));
  console.log("Preço atual: ~0.0913");
}

main();