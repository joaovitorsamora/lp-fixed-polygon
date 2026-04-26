import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const KEEPER = "0xde95b32d6B0ff10C5Bcec9e13F41aCA94D352e67";
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);

const abi = [
  "function rebalance(int24 newTickLower, int24 newTickUpper, uint256 currentPrice) external"
];

const contract = new ethers.Contract(KEEPER, abi, provider);

async function main() {
  try {
    const gas = await contract.rebalance.estimateGas(-303740, -300000, 0);
    console.log("✅ Function exists! Gas:", gas.toString());
  } catch (e: any) {
    console.log("❌ Error:", e.message.slice(0, 80));
  }
}

main();