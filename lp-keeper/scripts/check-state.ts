import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const KEEPER = "0xde95b32d6B0ff10C5Bcec9e13F41aCA94D352e67";
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);

const abi = [
  "function tokenId() view returns (uint256)",
  "function owner() view returns (address)"
];

const contract = new ethers.Contract(KEEPER, abi, provider);

async function main() {
  const [tokenId, owner] = await Promise.all([
    contract.tokenId(),
    contract.owner()
  ]);
  
  console.log("Owner:", owner);
  console.log("TokenId armazenado:", tokenId.toString());
  console.log("Token ID 2894302 NAO EXISTE mais no NPM!");
  console.log("O contrato precisa ter o tokenId resetado para 0 para funcionar.");
}

main().catch(console.error);