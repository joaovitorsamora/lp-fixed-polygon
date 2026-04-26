// scripts/rebalance-centered.ts
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

function tickFromPriceUSD(price: number): number {
  return Math.round(Math.log(price / 1e12) / Math.log(1.0001));
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

  // ── Ticks centrados ±15% ──────────────────────────────────────────────────
  const SPACING = 10;
  const lP = currentPriceUSD * 0.85;
  const uP = currentPriceUSD * 1.15;
  const tickLower = Math.floor(tickFromPriceUSD(lP) / SPACING) * SPACING;
  const tickUpper = Math.ceil(tickFromPriceUSD(uP) / SPACING) * SPACING;

  console.log("\n📐 Ticks centrados ±15%:");
  console.log("   tickLower:", tickLower, "→ $" + priceFromTick(tickLower).toFixed(5));
  console.log("   currentTick:", currentTick, "→ $" + currentPriceUSD.toFixed(5), "(centro)");
  console.log("   tickUpper:", tickUpper, "→ $" + priceFromTick(tickUpper).toFixed(5));
  console.log("   IN RANGE?", tickLower <= currentTick && currentTick < tickUpper ? "✅" : "❌");

  const currentPrice = BigInt(Math.round(currentPriceUSD * 1e18));

  // ── Passo 1: zerar slippage para permitir mint proporcional ──────────────
  // Com 100% WPOL e zero USDC, o NPM usa só a fração de token0
  // min0 precisa ser 0 para não rejeitar essa fração
  if (slippage !== 0n) {
    console.log("\n⚙️  Zerando slippage (necessário para mint single-asset)...");
    const txS = await contract.setSlippageBps(0, { gasLimit: 80_000 });
    console.log("   TX:", txS.hash);
    await txS.wait();
    console.log("   ✅ Slippage = 0");
  }

  // ── Passo 2: rebalance centrado ────────────────────────────────────────────
  console.log("\n💰 Estimando gas...");
  let gasEst: bigint;
  try {
    gasEst = await contract.rebalance.estimateGas(tickLower, tickUpper, currentPrice);
  } catch (e: any) {
    console.error("❌ estimateGas falhou:", e.shortMessage || e.message);
    // Restaurar slippage se falhar
    console.log("   Restaurando slippage para 100bps...");
    await contract.setSlippageBps(100, { gasLimit: 80_000 }).then((t: any) => t.wait());
    process.exit(1);
  }

  const feeData = await provider.getFeeData();
  const custo   = gasEst * (feeData.gasPrice ?? 100_000_000_000n);
  console.log("   Gas:", gasEst.toString());
  console.log("   Custo:", ethers.formatEther(custo), "POL");

  if (polBal < custo + keeperReserve) {
    console.error("❌ POL insuficiente:", ethers.formatEther(custo + keeperReserve), "necessário");
    process.exit(1);
  }

  console.log("\n🔄 Enviando rebalance centrado...");
  const tx = await contract.rebalance(tickLower, tickUpper, currentPrice, {
    gasLimit: gasEst * 120n / 100n,
  });

  console.log("   TX:", tx.hash);
  const receipt = await tx.wait();

  if (receipt.status === 0) {
    console.error("❌ Reverteu:", `https://polygonscan.com/tx/${tx.hash}`);
    process.exit(1);
  }

  // ── Passo 3: restaurar slippage para 100bps ────────────────────────────────
  console.log("\n⚙️  Restaurando slippage para 100bps...");
  await contract.setSlippageBps(100, { gasLimit: 80_000 }).then((t: any) => t.wait());
  console.log("   ✅ Slippage restaurado");

  console.log("\n✅ Sucesso! Gas:", receipt.gasUsed.toString());
  console.log("🎯 Range centrado: $" + priceFromTick(tickLower).toFixed(4) + " – $" + priceFromTick(tickUpper).toFixed(4));
  console.log("   https://revert.finance/#/account/0xde95b32d6b0ff10c5bcec9e13f41aca94d352e67/polygon");
}

main().catch(console.error);