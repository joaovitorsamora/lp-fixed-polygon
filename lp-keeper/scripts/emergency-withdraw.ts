import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const KEEPER = "0xde95b32d6B0ff10C5Bcec9e13F41aCA94D352e67";
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const abi = [
  "function emergencyWithdraw(address recipient) external",
  "function owner() view returns (address)"
];

const contract = new ethers.Contract(KEEPER, abi, wallet);

async function main() {
  const owner = await contract.owner();
  console.log("Owner:", owner);
  console.log("Wallet:", wallet.address);
  
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error("❌ Nao e owner!");
    process.exit(1);
  }
  
  console.log("Chamando emergencyWithdraw...");
  const tx = await contract.emergencyWithdraw(wallet.address, { gasLimit: 100000 });
  console.log("TX:", tx.hash);
  const r = await tx.wait();
  console.log("Status:", r.status);
  console.log("✅ Sucesso!");
}

main().catch(e => console.log("Erro:", e.message));