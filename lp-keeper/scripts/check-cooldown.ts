// scripts/check-cooldown.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const KEEPER_CONTRACT = "0xde95b32d6B0ff10C5Bcec9e13F41aCA94D352e67";
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);

const contract = new ethers.Contract(KEEPER_CONTRACT, [
  "function cooldownSeconds() view returns (uint256)",
  "function lastRebalanceTs() view returns (uint256)",
  "function paused() view returns (bool)",
], provider);

async function main() {
  const [cooldown, lastReb, paused] = await Promise.all([
    contract.cooldownSeconds(),
    contract.lastRebalanceTs(),
    contract.paused(),
  ]);
  
  const now = BigInt(Math.floor(Date.now() / 1000));
  const cooldownEnd = lastReb + cooldown;
  const cooldownLeft = cooldownEnd > now ? cooldownEnd - now : 0n;
  
  console.log("=== Estado do Keeper ===");
  console.log("paused:", paused);
  console.log("cooldownSeconds:", cooldown.toString());
  console.log("lastRebalanceTs:", lastReb.toString());
  console.log("cooldown restante:", Number(cooldownLeft), "segundos");
  console.log("cooldown restante:", (Number(cooldownLeft) / 60).toFixed(1), "minutos");
  
  if (paused) {
    console.log("\n❌ Contrato pausado!");
  } else if (cooldownLeft > 0n) {
    console.log("\n⏳ Cooldown ativo. Aguarde para rebalancear.");
  } else {
    console.log("\n✅ Pronto para rebalancear!");
  }
}

main();