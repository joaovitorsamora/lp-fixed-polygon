// scripts/emergency-exit.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const KEEPER_CONTRACT = "0xA4F5aCA0000f2867F30aD1833f5E939A21eE575E"; // seu contrato
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const abi = [
  "function emergencyWithdraw(address recipient) external",
  "function owner() view returns (address)"
];

const contract = new ethers.Contract(KEEPER_CONTRACT, abi, wallet);

async function main() {
  const owner = await contract.owner();
  console.log("Owner do contrato:", owner);
  console.log("Sua wallet:       ", wallet.address);

  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error("❌ Sua wallet não é o owner! Só o owner pode chamar emergencyWithdraw.");
    process.exit(1);
  }

  console.log("🚨 Chamando emergencyWithdraw...");
  const tx = await contract.emergencyWithdraw(wallet.address);
  console.log("TX enviada:", tx.hash);
  await tx.wait();
  console.log("✅ Fundos enviados para sua wallet!");
}

main().catch(console.error);