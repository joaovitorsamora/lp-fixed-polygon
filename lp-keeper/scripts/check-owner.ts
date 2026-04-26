import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const KEEPER = "0xde95b32d6B0ff10C5Bcec9e13F41aCA94D352e67";
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const abi = [
  "function owner() view returns (address)",
  "function tokenId() view returns (uint256)",
  "function emergencyWithdraw(address recipient) external"
];

const contract = new ethers.Contract(KEEPER, abi, provider);

async function main() {
  const [owner, tokenId] = await Promise.all([
    contract.owner(),
    contract.tokenId()
  ]);
  
  console.log("Owner:", owner);
  console.log("Wallet:", wallet.address);
  console.log("TokenId armazenado:", tokenId.toString());
  console.log("Sao iguais?", owner.toLowerCase() === wallet.address.toLowerCase());
}

main().catch(console.error);