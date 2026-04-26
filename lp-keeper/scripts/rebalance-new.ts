// scripts/rebalance-new.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const KEEPER_CONTRACT = "0xde95b32d6B0ff10C5Bcec9e13F41aCA94D352e67";
const FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const contract = new ethers.Contract(KEEPER_CONTRACT, [
  "function rebalance(int24,int24,uint256) external",
  "function setSlippageBps(uint256 bps) external",
  "function slippageBps() view returns (uint256)",
  "function tokenId() view returns (uint256)",
  "function cooldownSeconds() view returns (uint256)",
  "function lastRebalanceTs() view returns (uint256)",
  "function keeperEthReserve() view returns (uint256)",
], wallet);

const factory = new ethers.Contract(FACTORY, [
  "function getPool(address,address,uint24) view returns (address)",
], provider);

// Calculate tick from price
function priceToTick(price: number): number {
  return Math.floor(Math.log(price) / Math.log(1.0001));
}

async function main() {
  console.log("=== Rebalance com Ticks Automáticos ===\n");

  // ── Verificar cooldown ─────────────────────────────────────────────────────
  const [tokenId, cooldown, lastReb, slippage, keeperReserve] = await Promise.all([
    contract.tokenId(),
    contract.cooldownSeconds(),
    contract.lastRebalanceTs(),
    contract.slippageBps(),
    contract.keeperEthReserve(),
  ]);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const cooldownLeft = (lastReb + cooldown) > now ? (lastReb + cooldown) - now : 0n;
  const polBal = await provider.getBalance(wallet.address);

  console.log("tokenId:", tokenId.toString());
  console.log("cooldown restante:", Number(cooldownLeft), "s");
  console.log("POL na wallet:", ethers.formatEther(polBal));

  if (cooldownLeft > 0n) {
    console.error(`\n❌ Aguarde ${Number(cooldownLeft)}s (${(Number(cooldownLeft)/60).toFixed(1)} min)`);
    process.exit(1);
  }

  // ── Obter preço atual do pool ─────────────────────────────────────────────
  const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
  const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
  
  const pool = await factory.getPool(WMATIC, USDC, 500);
  console.log("\nPool:", pool);

  // Get slot0 via direct call
  const slot0Data = await provider.call({ to: pool, data: "0x6c8f5c8a" });
  
  if (!slot0Data || slot0Data === "0x") {
    console.error("❌ Não foi possível obter preço do pool");
    process.exit(1);
  }

  // Parse tick from slot0
  const hex = slot0Data.slice(2);
  const tickHex = "0x" + hex.slice(40, 48);
  let currentTick = parseInt(tickHex.slice(2), 16);
  if (currentTick > 0x7FFFFF) {
    currentTick = currentTick - 0x1000000;
  }

  console.log("currentTick:", currentTick);

  // ── Calcular novo range (±15%) ───────────────────────────────────────────
  const rangePercent = 0.15;
  const currentPrice = 1.0001 ** currentTick;
  const priceLower = currentPrice * (1 - rangePercent);
  const priceUpper = currentPrice * (1 + rangePercent);

  const tickLower = Math.floor(Math.log(priceLower) / Math.log(1.0001));
  const tickUpper = Math.floor(Math.log(priceUpper) / Math.log(1.0001));

  // Round to nearest tick spacing (60 for 0.05% fee)
  const tickSpacing = 60;
  const newTickLower = Math.floor(tickLower / tickSpacing) * tickSpacing;
  const newTickUpper = Math.ceil(tickUpper / tickSpacing) * tickSpacing;

  console.log("\n=== Novo Range ===");
  console.log("tickLower:", newTickLower);
  console.log("tickUpper:", newTickUpper);
  console.log("Preço range:", (1.0001 ** newTickLower).toFixed(6), "–", (1.0001 ** newTickUpper).toFixed(6));

  // ── Executar rebalance ─────────────────────────────────────────────────────
  if (slippage < 500n) {
    console.log("\n⚙️  Aumentando slippage para 500bps...");
    const txS = await contract.setSlippageBps(500, { gasLimit: 80_000 });
    await txS.wait();
    console.log("✅ Slippage atualizado");
  }

  // Get current price for the call
  const currentPrice = ethers.parseUnits((1.0001 ** currentTick).toFixed(8), 18);

  console.log("\n⚙️  Executando rebalance...");
  const gasEst = await contract.rebalance.estimateGas(newTickLower, newTickUpper, currentPrice);
  const feeData = await provider.getFeeData();
  const custo = gasEst * (feeData.gasPrice ?? 100_000_000_000n);

  console.log("Gas estimado:", gasEst.toString());
  console.log("Custo:", ethers.formatEther(custo), "POL");

  if (polBal < custo + keeperReserve) {
    console.error("❌ POL insuficiente!");
    process.exit(1);
  }

  const tx = await contract.rebalance(newTickLower, newTickUpper, currentPrice, {
    gasLimit: gasEst * 120n / 100n,
  });

  console.log("TX:", tx.hash);
  const receipt = await tx.wait();

  if (receipt.status === 0) {
    console.error("❌ Rebalance falhou!");
    process.exit(1);
  }

  console.log("\n✅ Rebalance concluído!");
  console.log("   Gas usado:", receipt.gasUsed.toString());
}

main().catch(console.error);