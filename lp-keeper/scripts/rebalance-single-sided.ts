// scripts/rebalance-single-sided.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const KEEPER_CONTRACT = "0xde95b32d6B0ff10C5Bcec9e13F41aCA94D352e67";
const POOL = "0xB6e57ed85c4c9dbfEF2a68711e9d6f36c56e0FcB";

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const pool = new ethers.Contract(POOL, [
  "function slot0() external view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"
], provider);

const contract = new ethers.Contract(KEEPER_CONTRACT, [
  "function rebalance(int24,int24,uint256) external",
  "function slippageBps() view returns (uint256)",
  "function tokenId() view returns (uint256)",
  "function cooldownSeconds() view returns (uint256)",
  "function lastRebalanceTs() view returns (uint256)",
  "function keeperEthReserve() view returns (uint256)",
], wallet);

async function main() {
  // ── Ler tick atual DIRETAMENTE do pool ────────────────────────────────────
  console.log("📡 Lendo tick atual do pool on-chain...");
  const slot0 = await pool.slot0();
  const currentTick: number = Number(slot0[1]);
  const sqrtPriceX96: bigint = slot0[0];

  // Calcular preço a partir do sqrtPriceX96
  const Q96 = 2n ** 96n;
  const priceRaw = Number(sqrtPriceX96 * sqrtPriceX96 * BigInt(1e6)) / Number(Q96 * Q96 * BigInt(1e18));
  
  console.log("currentTick do pool:", currentTick);
  console.log("preço atual:", priceRaw.toFixed(6), "USDC/WPOL");

  // ── Estado do contrato ────────────────────────────────────────────────────
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

  console.log("\ntokenId:", tokenId.toString());
  console.log("slippage:", slippage.toString(), "bps");
  console.log("cooldown restante:", cooldownLeft.toString(), "s");
  console.log("POL na wallet:", ethers.formatEther(polBal));

  if (cooldownLeft > 0n) {
    console.error(`\n❌ Aguarde ${cooldownLeft}s (~${Math.ceil(Number(cooldownLeft)/60)} min)`);
    process.exit(1);
  }

  // ── Calcular ticks single-sided WPOL ─────────────────────────────────────
  // Como temos 100% WPOL, a posição deve ficar COM TICKLOWER > CURRENTTICK
  // Assim o Uniswap V3 aceita 100% token0 e a posição fica "in range aguardando"
  const TICK_SPACING = 10;
  
  // tickLower = currentTick + 1 tick de espaço (alinhado)
  const tickLower = (Math.floor(currentTick / TICK_SPACING) + 1) * TICK_SPACING;
  // tickUpper = 30% acima (range amplo para não sair tão rápido)
  const tickUpper = Math.ceil((currentTick * 1.30) / TICK_SPACING) * TICK_SPACING;

  const priceAtLower = Math.pow(1.0001, tickLower) / 1e12;
  const priceAtUpper = Math.pow(1.0001, tickUpper) / 1e12;

  console.log("\n=== Ticks Single-Sided WPOL ===");
  console.log("tickLower:", tickLower, "→ $" + priceAtLower.toFixed(5));
  console.log("tickUpper:", tickUpper, "→ $" + priceAtUpper.toFixed(5));
  console.log("currentTick:", currentTick, "→ $" + priceRaw.toFixed(5));
  console.log("Posição: 100% WPOL, ativa quando preço subir acima de $" + priceAtLower.toFixed(5));

  // currentPrice para o contrato (não afeta os ticks, só é armazenado)
  const currentPrice = BigInt(Math.round(priceRaw * 1e18));

  // ── Estimar gas ───────────────────────────────────────────────────────────
  console.log("\n💰 Estimando gas...");
  let gasEst: bigint;
  try {
    gasEst = await contract.rebalance.estimateGas(tickLower, tickUpper, currentPrice);
  } catch (e: any) {
    console.error("❌ estimateGas falhou:", e.shortMessage || e.message);
    process.exit(1);
  }

  const feeData = await provider.getFeeData();
  const custo = gasEst * (feeData.gasPrice ?? 100_000_000_000n);
  console.log("Gas estimado:", gasEst.toString());
  console.log("Custo estimado:", ethers.formatEther(custo), "POL");
  console.log("POL disponível:", ethers.formatEther(polBal));

  if (polBal < custo + keeperReserve) {
    console.error("\n❌ POL insuficiente!");
    console.error("   Necessário:", ethers.formatEther(custo + keeperReserve));
    console.error("   Disponível:", ethers.formatEther(polBal));
    process.exit(1);
  }

  // ── Executar ──────────────────────────────────────────────────────────────
  console.log("\n🔄 Executando rebalance single-sided...");
  const tx = await contract.rebalance(tickLower, tickUpper, currentPrice, {
    gasLimit: gasEst * 120n / 100n,
  });

  console.log("TX:", tx.hash);
  const receipt = await tx.wait();

  if (receipt.status === 0) {
    console.error("❌ Reverteu:", `https://polygonscan.com/tx/${tx.hash}`);
    process.exit(1);
  }

  console.log("\n✅ Rebalance ok! Gas usado:", receipt.gasUsed.toString());
  console.log("🎯 Posição agora está IN RANGE (single-sided WPOL)");
  console.log("   Gera fees quando preço subir acima de $" + priceAtLower.toFixed(5));
  console.log("   https://revert.finance/#/account/0xde95b32d6b0ff10c5bcec9e13f41aca94d352e67/polygon");
}

main().catch(console.error);