// scripts/rebalance-single-sided.ts — VERSÃO FINAL CORRETA
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const KEEPER_CONTRACT = "0xde95b32d6B0ff10C5Bcec9e13F41aCA94D352e67";
const POOL = "0xB6e57ed85c4c9dbfEF2a68711e9d6f36c56e0FcB";

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const pool = new ethers.Contract(POOL, [
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"
], provider);

const contract = new ethers.Contract(KEEPER_CONTRACT, [
  "function rebalance(int24,int24,uint256) external",
  "function slippageBps() view returns (uint256)",
  "function tokenId() view returns (uint256)",
  "function cooldownSeconds() view returns (uint256)",
  "function lastRebalanceTs() view returns (uint256)",
  "function keeperEthReserve() view returns (uint256)",
], wallet);

function priceFromTick(tick: number): number {
  return Math.pow(1.0001, tick) * 1e12;
}

async function main() {
  // ── Ler tick atual do pool ─────────────────────────────────────────────────
  const slot0 = await pool.slot0();
  const currentTick = Number(slot0[1]);
  const currentPriceUSD = priceFromTick(currentTick);

  console.log("📡 Pool on-chain:");
  console.log("   currentTick:", currentTick);
  console.log("   preço atual: $" + currentPriceUSD.toFixed(5));

  // ── Estado do contrato ─────────────────────────────────────────────────────
  const [tokenId, cooldown, lastReb, keeperReserve] = await Promise.all([
    contract.tokenId(),
    contract.cooldownSeconds(),
    contract.lastRebalanceTs(),
    contract.keeperEthReserve(),
  ]);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const cooldownLeft = (lastReb + cooldown) > now ? (lastReb + cooldown) - now : 0n;
  const polBal = await provider.getBalance(wallet.address);

  console.log("\n📋 Contrato:");
  console.log("   tokenId:", tokenId.toString());
  console.log("   cooldown:", cooldownLeft.toString(), "s");
  console.log("   POL:", ethers.formatEther(polBal));

  if (cooldownLeft > 0n) {
    console.error(`\n❌ Aguarde ${cooldownLeft}s (~${Math.ceil(Number(cooldownLeft)/60)} min)`);
    process.exit(1);
  }

  // ── Ticks single-sided: tickLower ACIMA do currentTick ────────────────────
  // Isso garante posição 100% WPOL — NPM usa todo o amount0, sem revert de slippage
  const SPACING = 10;
  const tickLower = (Math.floor(currentTick / SPACING) + 2) * SPACING; // 2 espaços acima
  const tickUpper = tickLower + 3000;                                   // range ~30% acima

  const priceLower = priceFromTick(tickLower);
  const priceUpper = priceFromTick(tickUpper);

  console.log("\n📐 Ticks single-sided WPOL:");
  console.log("   currentTick:", currentTick, "→ $" + currentPriceUSD.toFixed(5));
  console.log("   tickLower:  ", tickLower,    "→ $" + priceLower.toFixed(5), "(preço de ativação)");
  console.log("   tickUpper:  ", tickUpper,    "→ $" + priceUpper.toFixed(5));
  console.log("   currentTick < tickLower?", currentTick < tickLower ? "✅ single-sided válido" : "❌");
  console.log("   tL < tU?",    tickLower < tickUpper ? "✅" : "❌");
  console.log("   alinhados?",  tickLower % 10 === 0 && tickUpper % 10 === 0 ? "✅" : "❌");
  console.log("   Posição ativa quando preço subir acima de $" + priceLower.toFixed(5));

  if (currentTick >= tickLower || tickLower >= tickUpper) {
    console.error("\n❌ Ticks inválidos — abortando");
    process.exit(1);
  }

  const currentPrice = BigInt(Math.round(currentPriceUSD * 1e18));

  // ── Estimar gas ────────────────────────────────────────────────────────────
  console.log("\n💰 Estimando gas...");
  let gasEst: bigint;
  try {
    gasEst = await contract.rebalance.estimateGas(tickLower, tickUpper, currentPrice);
  } catch (e: any) {
    console.error("❌ estimateGas falhou:", e.shortMessage || e.message);
    process.exit(1);
  }

  const feeData = await provider.getFeeData();
  const custo   = gasEst * (feeData.gasPrice ?? 100_000_000_000n);
  console.log("   Gas:", gasEst.toString());
  console.log("   Custo:", ethers.formatEther(custo), "POL");

  if (polBal < custo + keeperReserve) {
    console.error("❌ POL insuficiente! Precisa:", ethers.formatEther(custo + keeperReserve));
    process.exit(1);
  }

  // ── Enviar ─────────────────────────────────────────────────────────────────
  console.log("\n🔄 Enviando rebalance...");
  const tx = await contract.rebalance(tickLower, tickUpper, currentPrice, {
    gasLimit: gasEst * 120n / 100n,
  });

  console.log("   TX:", tx.hash);
  const receipt = await tx.wait();

  if (receipt.status === 0) {
    console.error("❌ Reverteu:", `https://polygonscan.com/tx/${tx.hash}`);
    process.exit(1);
  }

  console.log("\n✅ Sucesso! Gas:", receipt.gasUsed.toString());
  console.log("🎯 Posição single-sided WPOL criada");
  console.log("   Ativa (gera fees) quando WPOL subir acima de $" + priceLower.toFixed(5));
  console.log("   https://revert.finance/#/account/0xde95b32d6b0ff10c5bcec9e13f41aca94d352e67/polygon");
}

main().catch(console.error);