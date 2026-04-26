// scripts/rebalance-asymmetric.ts
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
  "function setSlippageBps(uint256) external",
  "function slippageBps() view returns (uint256)",
  "function tokenId() view returns (uint256)",
  "function cooldownSeconds() view returns (uint256)",
  "function lastRebalanceTs() view returns (uint256)",
  "function keeperEthReserve() view returns (uint256)",
], wallet);

function priceFromTick(tick: number): number {
  return Math.pow(1.0001, tick) * 1e12;
}

function sqrtPrice(tick: number): number {
  return Math.sqrt(Math.pow(1.0001, tick));
}

async function main() {
  // ── Pool ──────────────────────────────────────────────────────────────────
  const slot0 = await pool.slot0();
  const currentTick = Number(slot0[1]);
  const currentPriceUSD = priceFromTick(currentTick);

  console.log("📡 Pool on-chain:");
  console.log("   currentTick:", currentTick);
  console.log("   preço atual: $" + currentPriceUSD.toFixed(5));

  // ── Contrato ───────────────────────────────────────────────────────────────
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

  console.log("\n📋 Contrato:");
  console.log("   tokenId:", tokenId.toString());
  console.log("   slippage:", slippage.toString(), "bps");
  console.log("   cooldown:", cooldownLeft.toString(), "s");
  console.log("   POL:", ethers.formatEther(polBal));

  if (cooldownLeft > 0n) {
    console.error(`\n❌ Aguarde ${cooldownLeft}s (~${Math.ceil(Number(cooldownLeft)/60)} min)`);
    process.exit(1);
  }

  // ── Calcular ticks assimétricos ───────────────────────────────────────────
  // tickLower: 30% abaixo do preço atual (amplo, lado esquerdo)
  // tickUpper: calculado para que o NPM use >= 91% do WPOL disponível
  // Isso garante que amount0_usado >= min0 com slippage=1000bps (máximo permitido)
  const SPACING = 10;
  const sqrtC = sqrtPrice(currentTick);

  // tickLower fixo: 30% abaixo
    const tickLower = -303740;
    const sqrtL = sqrtPrice(tickLower);

  // tickUpper: resolver para fração = 93% (margem sobre o mínimo de 90%)
  // fração = (sqrtC - sqrtL) / (sqrtU - sqrtL) = 0.93
  // sqrtU = (sqrtC - sqrtL) / 0.93 + sqrtL
  const targetFraction = 0.93;
  const sqrtU_needed = (sqrtC - sqrtL) / targetFraction + sqrtL;
  const tickU_raw = Math.log(sqrtU_needed * sqrtU_needed) / Math.log(1.0001);
  // tickUpper: currentTick + 170 ticks (margem segura de ~2.5 WPOL sobre o mínimo)
const tickUpper = (Math.floor(currentTick / SPACING) + 17) * SPACING;// Verificar fração real com ticks alinhados
  const sqrtU = sqrtPrice(tickUpper);
  const realFraction = (sqrtC - sqrtL) / (sqrtU - sqrtL);
  const amount0 = 49.11431446;
  const wpolUsed = amount0 * realFraction;
  const min0_1000bps = amount0 * 0.90;

  console.log("\n📐 Ticks assimétricos (lower amplo, upper próximo):");
  console.log("   tickLower:", tickLower, "→ $" + priceFromTick(tickLower).toFixed(5));
  console.log("   currentTick:", currentTick, "→ $" + currentPriceUSD.toFixed(5), "(dentro do range)");
  console.log("   tickUpper:", tickUpper, "→ $" + priceFromTick(tickUpper).toFixed(5));
  console.log("   fração WPOL usado:", (realFraction * 100).toFixed(1) + "%");
  console.log("   WPOL estimado usado:", wpolUsed.toFixed(2), "de", amount0.toFixed(2));
  console.log("   min0 (slippage 1000bps):", min0_1000bps.toFixed(2));
  console.log("   passa slippage check?", wpolUsed >= min0_1000bps ? "✅ SIM" : "❌ NÃO");
  console.log("   IN RANGE?", tickLower <= currentTick && currentTick < tickUpper ? "✅" : "❌");

  if (!(tickLower <= currentTick && currentTick < tickUpper) || wpolUsed < min0_1000bps) {
    console.error("\n❌ Validação falhou — abortando");
    process.exit(1);
  }

  // ── Passo 1: ajustar slippage para 1000bps (máximo) ───────────────────────
  if (slippage !== 1000n) {
    console.log("\n⚙️  Ajustando slippage para 1000bps...");
    const txS = await contract.setSlippageBps(1000, { gasLimit: 80_000 });
    console.log("   TX:", txS.hash);
    await txS.wait();
    console.log("   ✅ Slippage = 1000bps");
  }

  const currentPrice = BigInt(Math.round(currentPriceUSD * 1e18));

  // ── Passo 2: rebalance ────────────────────────────────────────────────────
  console.log("\n💰 Estimando gas...");
  let gasEst: bigint;
  try {
    gasEst = await contract.rebalance.estimateGas(tickLower, tickUpper, currentPrice);
  } catch (e: any) {
    console.error("❌ estimateGas falhou:", e.shortMessage || e.message);
    console.log("   Restaurando slippage para 100bps...");
    await contract.setSlippageBps(100, { gasLimit: 80_000 }).then((t: any) => t.wait());
    process.exit(1);
  }

  const feeData = await provider.getFeeData();
  const custo   = gasEst * (feeData.gasPrice ?? 100_000_000_000n);
  console.log("   Gas:", gasEst.toString());
  console.log("   Custo:", ethers.formatEther(custo), "POL");

  console.log("\n🔄 Enviando rebalance...");
  const tx = await contract.rebalance(tickLower, tickUpper, currentPrice, {
    gasLimit: gasEst * 120n / 100n,
  });

  console.log("   TX:", tx.hash);
  const receipt = await tx.wait();

  if (receipt.status === 0) {
    console.error("❌ Reverteu:", `https://polygonscan.com/tx/${tx.hash}`);
    await contract.setSlippageBps(100, { gasLimit: 80_000 }).then((t: any) => t.wait());
    process.exit(1);
  }

  // ── Passo 3: restaurar slippage ───────────────────────────────────────────
  console.log("\n⚙️  Restaurando slippage para 100bps...");
  await contract.setSlippageBps(100, { gasLimit: 80_000 }).then((t: any) => t.wait());
  console.log("   ✅ Slippage restaurado");

  console.log("\n✅ Sucesso! Gas usado:", receipt.gasUsed.toString());
  console.log("🎯 Posição IN RANGE: $" + priceFromTick(tickLower).toFixed(4) + " – $" + priceFromTick(tickUpper).toFixed(4));
  console.log("   Preço atual ($" + currentPriceUSD.toFixed(4) + ") dentro do range");
  console.log("   https://revert.finance/#/account/0xde95b32d6b0ff10c5bcec9e13f41aca94d352e67/polygon");
}

main().catch(console.error);