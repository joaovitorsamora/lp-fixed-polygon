// scripts/rebalance-reset.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const KEEPER_CONTRACT = "0xde95b32d6B0ff10C5Bcec9e13F41aCA94D352e67";
const POOL = "0xB6e57ed85c4c9dbfEF2a68711e9d6f36c56e0FcB";

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

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

function calcPriceFromSqrtPriceX96(
  sqrtPriceX96: bigint,
  token0Decimals: number,
  token1Decimals: number
): number {
  const Q96 = 2n ** 96n;
  const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
  const factor = Math.pow(10, token1Decimals - token0Decimals);
  return sqrtPrice ** 2 * factor;
}

async function main() {
  // ── Ler tick atual do pool on-chain ───────────────────────────────────────
  console.log("📡 Lendo tick atual do pool on-chain...");
  const slot0 = await pool.slot0();
  const currentTick: number = Number(slot0[1]);
  const sqrtPriceX96: bigint = slot0[0];

  // Ajuste: WPOL (18) / USDC (6) → token0/token1 → factor 1e12
  // Se o pool for USDC/WPOL, troque 18/6 → 6/18 (fator 1e12)
  const token0Decimals = 18; // WPOL
  const token1Decimals = 6;  // USDC
  const priceRaw = calcPriceFromSqrtPriceX96(sqrtPriceX96, token0Decimals, token1Decimals);

  if (priceRaw < 1e-8) {
    console.error("❌ Preço calculado muito baixo; provavelmente ordem ou fator incorretos.");
    console.error("Verifique se o pool é WPOL/USDC (18/6) e o fator.");
    process.exit(1);
  }

  console.log("currentTick do pool:", currentTick);
  console.log("preço atual (USDC/WPOL):", priceRaw.toFixed(8));

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
    console.error(`\n❌ Aguarde ${cooldownLeft}s (~${Math.ceil(Number(cooldownLeft) / 60)} min)`);
    process.exit(1);
  }

  // ── Calcular ticks single-sided WPOL ──────────────────────────────────────
  const TICK_SPACING = 10;

  // tickLower: primeiro tick >= currentTick, alinhado
  const tickLower = Math.ceil(currentTick / TICK_SPACING) * TICK_SPACING;

  // 15% acima do preço atual (em preço, não em tick)
  const targetUpperPrice = priceRaw * 1.15;
  const tickUpperUnaligned = Math.floor(Math.log(targetUpperPrice * 1e12) / Math.log(1.0001));
  const tickUpper = Math.ceil(tickUpperUnaligned / TICK_SPACING) * TICK_SPACING;

  // Sanity check
  if (tickUpper <= tickLower) {
    console.error("❌ tickUpper <= tickLower; ajuste o fator de 1.15 para maior ou menor.");
    process.exit(1);
  }

  const priceAtLower = Math.pow(1.0001, tickLower) / 1e12;
  const priceAtUpper = Math.pow(1.0001, tickUpper) / 1e12;

  console.log("\n=== Ticks Single-Sided WPOL (corrigidos) ===");
  console.log("tickLower:", tickLower, "→ $" + priceAtLower.toFixed(6));
  console.log("tickUpper:", tickUpper, "→ $" + priceAtUpper.toFixed(6));
  console.log("currentTick:", currentTick, "→ $" + priceRaw.toFixed(6));
  console.log("Posição: 100% WPOL, ativa quando preço subir acima de $" + priceAtLower.toFixed(6));

  // currentPrice em 1e18 para o contrato
  const currentPrice = BigInt(Math.round(priceRaw * 1e18));

  // ── Estimar gas ───────────────────────────────────────────────────────────
  console.log("\n💰 Estimando gas...");
  let gasEst: bigint;
  try {
    gasEst = await contract.rebalance.estimateGas(tickLower, tickUpper, currentPrice);
  } catch (e: any) {
    console.error("❌ estimateGas falhou:");
    console.error(e.shortMessage || e.message);
    console.error("Se a mensagem for 'Price slippage check', ajuste slippage maior ou range mais amplo.");
    process.exit(1);
  }

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 100_000_000_000n;
  const custo = gasEst * gasPrice;
  console.log("Gas estimado:", gasEst.toString());
  console.log("Custo estimado:", ethers.formatEther(custo), "POL");
  console.log("POL disponível:", ethers.formatEther(polBal));

  if (polBal < custo + keeperReserve) {
    console.error("\n❌ POL insuficiente!");
    console.error("   Necessário:", ethers.formatEther(custo + keeperReserve));
    console.error("   Disponível:", ethers.formatEther(polBal));
    process.exit(1);
  }

  // ── Executar rebalance ─────────────────────────────────────────────────────
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
  console.log("   Gera fees quando preço subir acima de $" + priceAtLower.toFixed(6));
  console.log("   https://revert.finance/#/account/0xde95b32d6b0ff10c5bcec9e13f41aca94d352e67/polygon");
}

main().catch(console.error);