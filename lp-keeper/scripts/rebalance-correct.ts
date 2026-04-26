// scripts/rebalance-correct.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const KEEPER_CONTRACT = "0xde95b32d6B0ff10C5Bcec9e13F41aCA94D352e67";

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

async function main() {
  console.log("=== Rebalance Corrigido ===\n");

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
    console.error(`\n❌ Aguarde ${Number(cooldownLeft)}s`);
    process.exit(1);
  }

  // ── Calcular ticks corretos para preço $0.09131 ───────────────────────────
  // Preço atual: 0.09131 USDC/WMATIC
  // Range ±15%: 0.0776 - 0.105
  const currentPrice = 0.09131;
  const rangePercent = 0.15;
  
  const priceLower = currentPrice * (1 - rangePercent);
  const priceUpper = currentPrice * (1 + rangePercent);
  
  // Calcular ticks
  const tickFromPrice = Math.floor(Math.log(currentPrice) / Math.log(1.0001));
  const tickLower = Math.floor(Math.log(priceLower) / Math.log(1.0001));
  const tickUpper = Math.floor(Math.log(priceUpper) / Math.log(1.0001));
  
  // Arredondar para tickSpacing = 60
  const tickSpacing = 60;
  const rawTickLower = Math.floor(tickLower / tickSpacing) * tickSpacing;
  const rawTickUpper = Math.ceil(tickUpper / tickSpacing) * tickSpacing;
  
  console.log("\n=== Ticks Calculados ===");
  console.log("currentPrice:", currentPrice);
  console.log("priceLower:", priceLower.toFixed(6));
  console.log("priceUpper:", priceUpper.toFixed(6));
  console.log("tickLower (real):", tickLower);
  console.log("tickUpper (real):", tickUpper);
  console.log("rawTickLower:", rawTickLower);
  console.log("rawTickUpper:", rawTickUpper);

  // ── Executar rebalance ─────────────────────────────────────────────────────
  if (slippage < 500n) {
    console.log("\n⚙️  Aumentando slippage para 500bps...");
    const txS = await contract.setSlippageBps(500, { gasLimit: 80_000 });
    await txS.wait();
    console.log("✅ Slippage atualizado");
  }

  // Current price em wei
  const priceWei = ethers.parseUnits(currentPrice.toFixed(8), 18);

  console.log("\n⚙️  Executando rebalance...");
  const gasEst = await contract.rebalance.estimateGas(rawTickLower, rawTickUpper, priceWei);
  const feeData = await provider.getFeeData();
  const custo = gasEst * (feeData.gasPrice ?? 100_000_000_000n);

  console.log("Gas estimado:", gasEst.toString());
  console.log("Custo:", ethers.formatEther(custo), "POL");

  if (polBal < custo + keeperReserve) {
    console.error("❌ POL insuficiente!");
    process.exit(1);
  }

  const tx = await contract.rebalance(rawTickLower, rawTickUpper, priceWei, {
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