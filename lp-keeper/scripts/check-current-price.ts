// scripts/check-current-price.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const KEEPER_CONTRACT = "0xde95b32d6B0ff10C5Bcec9e13F41aCA94D352e67";
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);

const contract = new ethers.Contract(KEEPER_CONTRACT, [
  "function tokenId() view returns (uint256)",
  "function currentTick() view returns (int24)",
], provider);

async function main() {
  const [tokenId, currentTick] = await Promise.all([
    contract.tokenId(),
    contract.currentTick(),
  ]);
  
  console.log("tokenId:", tokenId.toString());
  console.log("currentTick:", currentTick.toString());
  
  // tickLower e tickUpper da posição
  const tickLower = 250750;
  const tickUpper = 253780;
  
  console.log("\n=== Análise do Range ===");
  console.log("tickLower:", tickLower);
  console.log("tickUpper:", tickUpper);
  console.log("currentTick:", currentTick.toString());
  
  if (Number(currentTick) >= tickLower && Number(currentTick) <= tickUpper) {
    console.log("\n✅ DENTRO do range!");
  } else {
    console.log("\n❌ FORA do range!");
  }
}

main();