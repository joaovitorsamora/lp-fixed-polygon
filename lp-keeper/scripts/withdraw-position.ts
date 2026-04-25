import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const keeper = new ethers.Contract(
  process.env.KEEPER_CONTRACT!,
  [
    "function harvest()",
    "function rebalance(int24,int24,uint256)"
  ],
  wallet
);

async function main() {
  console.log("🔎 Chamando harvest no Keeper...");

  const tx = await keeper.harvest();
  await tx.wait();

  console.log("✅ Harvest executado com sucesso");
}

main().catch(console.error);