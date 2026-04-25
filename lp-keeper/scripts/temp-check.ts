import { ethers } from "ethers";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../.env") });

const CONTRACT = "0xA4F5aCA0000f2867F30aD1833f5E939A21eE575E";
const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const USDC_CORRETO = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_ERRADO = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
const erc20 = ["function balanceOf(address) view returns (uint256)"];

const wpol = new ethers.Contract(WPOL, erc20, provider);
const usdcC = new ethers.Contract(USDC_CORRETO, erc20, provider);
const usdcE = new ethers.Contract(USDC_ERRADO, erc20, provider);

async function main() {
  const [wpolBal, usdcCorretoBal, usdcErradoBal] = await Promise.all([
    wpol.balanceOf(CONTRACT),
    usdcC.balanceOf(CONTRACT),
    usdcE.balanceOf(CONTRACT)
  ]);

  console.log("=== Saldos no Contrato 0xA4F5... ===");
  console.log("WPOL:", ethers.formatEther(wpolBal));
  console.log("USDC correto (0x2791...):", ethers.formatUnits(usdcCorretoBal, 6));
  console.log("USDC errado (0x3c49...):", ethers.formatUnits(usdcErradoBal, 6));
}

main().catch(console.error);