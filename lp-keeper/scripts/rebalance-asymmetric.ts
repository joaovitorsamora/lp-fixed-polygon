// scripts/harvest-only.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const CONTRACT = process.env.KEEPER_CONTRACT!;

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const contract = new ethers.Contract(CONTRACT, [
  "function harvest() external",
  "function slippageBps() view returns(uint256)",
  "function tokenId() view returns(uint256)",
  "function keeper() view returns(address)"
], wallet);

async function main() {
  console.log("🔧 TENTATIVA DE HARVEST — Mais segura possível");

  const [keeperAddr, tokenId, slip] = await Promise.all([
    contract.keeper(), contract.tokenId(), contract.slippageBps()
  ]);

  console.log(`tokenId: ${tokenId} | Slippage: ${slip}`);

  if (keeperAddr.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error("Não é keeper");
  }

  console.log("\nChamando harvest()...");
  try {
    const tx = await contract.harvest({ gasLimit: 400000 });
    console.log(`TX: ${tx.hash}`);
    const receipt = await tx.wait();
    if (receipt.status === 1) {
      console.log("✅ Harvest executado com sucesso!");
      console.log("Agora tente rebalance novamente.");
    } else {
      console.error("❌ Harvest revertido");
    }
  } catch (e: any) {
    console.error("❌ Harvest falhou:", e.shortMessage || e.message);
  }
}

main().catch(e => {
  console.error("❌ Erro:", e.message || e);
  process.exit(1);
});