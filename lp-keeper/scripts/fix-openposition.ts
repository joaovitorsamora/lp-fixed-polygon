/**
 * fix-openposition.ts — Abre a posição LP no contrato já deployado
 *
 * O deploy + transferência de tokens funcionou corretamente:
 *   Contrato: 0xA4F5aCA0000f2867F30aD1833f5E939A21eE575E
 *   WPOL depositado: 1.453391 WPOL ✅
 *   USDC depositado: 0.435579 USDC ✅
 *
 * O erro anterior foi por preço $0.000000 → ticks inválidos.
 * Este script corrige: busca preço correto e chama openPosition() diretamente.
 *
 * Uso:
 *   npx ts-node scripts/fix-openposition.ts
 */

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "../.env") });

// ─────────────────────────────────────────────────────────────────────────────
// Contrato deployado
// ─────────────────────────────────────────────────────────────────────────────

const CONTRACT  = process.env.KEEPER_CONTRACT ?? "0xA4F5aCA0000f2867F30aD1833f5E939A21eE575E";
const RPC_URL   = process.env.RPC_URL         ?? "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY!;

const WPOL_ADDR = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const USDC_ADDR = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC correto na Polygon

// Pool WPOL/USDC 0.05% na Polygon
// token0 = WPOL (18 dec) — menor endereço
// token1 = USDC  (6 dec)
const POOL_ADDR = "0xa374094527e1673a86de625aa59517c5de346d32";

// Tick spacing da pool 0.05% = 10
const TICK_SPACING = 10;

// ─────────────────────────────────────────────────────────────────────────────
// ABI mínimo
// ─────────────────────────────────────────────────────────────────────────────

const KEEPER_ABI = [
  // Variáveis públicas
  "function tokenId() external view returns (uint256)",
  "function posLiquidity() external view returns (uint128)",
  "function paused() external view returns (bool)",
  "function cooldownSeconds() external view returns (uint256)",
  "function lastRebalanceTs() external view returns (uint256)",
  "function tickLower() external view returns (int24)",
  "function tickUpper() external view returns (int24)",
  // Funções
  "function openPosition(int24 _tickLower, int24 _tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 currentPrice) external",
  "function canRebalance() external view returns (bool ok, string memory reason)",
];

const ERC20_ABI = [
  "function balanceOf(address) external view returns (uint256)",
];

const POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
];

// ─────────────────────────────────────────────────────────────────────────────
// Cálculo de ticks
//
// Par WPOL/USDC: token0=WPOL(18dec), token1=USDC(6dec)
// price_pool = (sqrtPriceX96 / 2^96)^2
// price_real (USDC/WPOL) = price_pool * 10^(dec1-dec0) = price_pool * 10^(6-18) = price_pool / 1e12
// POL em USD = price_real
// ─────────────────────────────────────────────────────────────────────────────

function priceToTick(price: number): number {
  return Math.floor(Math.log(price) / Math.log(1.0001));
}

function calcTicks(polPriceUSD: number, rangePct: number, tickSpacing: number) {
  // Preço na pool = USDC/WPOL com ajuste de decimais
  const priceInPool = polPriceUSD / 1e12;
  const priceLower  = priceInPool * (1 - rangePct);
  const priceUpper  = priceInPool * (1 + rangePct);

  const tickLower = Math.floor(priceToTick(priceLower) / tickSpacing) * tickSpacing;
  const tickUpper = Math.ceil(priceToTick(priceUpper)  / tickSpacing) * tickSpacing;

  return { tickLower, tickUpper };
}

// ─────────────────────────────────────────────────────────────────────────────
// Buscar preço do pool on-chain (fórmula corrigida)
// ─────────────────────────────────────────────────────────────────────────────

async function getPoolPrice(provider: ethers.JsonRpcProvider): Promise<number> {
  try {
    const pool = new ethers.Contract(POOL_ADDR, POOL_ABI, provider);

    // Verificar ordem dos tokens
    const token0 = (await pool.token0() as string).toLowerCase();
    const isWpolToken0 = token0 === WPOL_ADDR.toLowerCase();

    const slot0 = await pool.slot0();
    const tick = Number(slot0.tick);

    // Usar o tick diretamente para calcular o preço
    // price = 1.0001^tick (preço token1/token0)
    const rawPrice = Math.pow(1.0001, tick);

    let polPriceUSD: number;
    if (isWpolToken0) {
      // token0=WPOL(18), token1=USDC(6)
      // price = USDC/WPOL
      // POL em USD = 1/price
      polPriceUSD = 1 / rawPrice;
    } else {
      // token0=USDC(6), token1=WPOL(18)
      // price = WPOL/USDC = POL em USD
      polPriceUSD = rawPrice;
    }

    console.log(`  token0: ${isWpolToken0 ? "WPOL" : "USDC"}`);
    console.log(`  tick: ${tick}`);
    console.log(`  rawPrice (token1/token0): ${rawPrice.toExponential(6)}`);
    console.log(`  POL price: $${polPriceUSD.toFixed(6)}`);

    // Sanidade: POL deve estar entre $0.05 e $5.00
    if (polPriceUSD > 0.05 && polPriceUSD < 5.0) {
      return polPriceUSD;
    }

    console.log("  ⚠️  Preço fora do range esperado — usando fallback $0.093");
    return 0.093;

  } catch (e: any) {
    console.log(`  ⚠️  Erro ao ler pool: ${e.message} — usando fallback $0.093`);
    return 0.093;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"━".repeat(52)}`);
  console.log("🔧 Fix: openPosition() no contrato existente");
  console.log(`${"━".repeat(52)}\n`);

  if (!PRIVATE_KEY) {
    console.error("❌ PRIVATE_KEY não definida no .env");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const keeper   = new ethers.Contract(CONTRACT, KEEPER_ABI, wallet);

  console.log(`Contrato:  ${CONTRACT}`);
  console.log(`Carteira:  ${wallet.address}\n`);

  // ── Verificar estado do contrato ─────────────────────────────────────────
  console.log("📋 Estado atual do contrato...");

  // Ler saldos diretamente dos contratos ERC20
  const wpolContract = new ethers.Contract(WPOL_ADDR, ERC20_ABI, provider);
  const usdcContract = new ethers.Contract(USDC_ADDR, ERC20_ABI, provider);

  const [wpolBal, usdcBal, tokenId, isPaused] = await Promise.all([
    wpolContract.balanceOf(CONTRACT),
    usdcContract.balanceOf(CONTRACT),
    keeper.tokenId(),
    keeper.paused()
  ]) as [bigint, bigint, bigint, boolean];

  console.log(`  WPOL:     ${ethers.formatEther(wpolBal)} WPOL`);
  console.log(`  USDC:     ${ethers.formatUnits(usdcBal, 6)} USDC`);
  console.log(`  tokenId:  ${tokenId}`);
  console.log(`  paused:   ${isPaused}`);

  if (wpolBal === 0n && usdcBal === 0n) {
    console.error("\n❌ Contrato sem saldo de tokens. Transfira WPOL e/ou USDC primeiro.");
    process.exit(1);
  }

  if (isPaused) {
    console.error("\n❌ Contrato pausado. Chame resetCircuitBreaker() antes.");
    process.exit(1);
  }

  if (tokenId > 0n) {
    console.log(`\n⚠️  Já existe uma posição aberta (tokenId=${tokenId}).`);
    console.log("   Use rebalance() se quiser reposicionar.");
    process.exit(0);
  }

  // ── Buscar preço real ─────────────────────────────────────────────────────
  console.log("\n💱 Buscando preço real do pool WPOL/USDC...");
  const polPriceUSD = await getPoolPrice(provider);

  // ── Calcular ticks corretos ───────────────────────────────────────────────
  const RANGE_PCT = 0.05; // ±5%
  const ticks = calcTicks(polPriceUSD, RANGE_PCT, TICK_SPACING);

  const priceLower = polPriceUSD * (1 - RANGE_PCT);
  const priceUpper = polPriceUSD * (1 + RANGE_PCT);

  console.log(`\n📐 Range calculado:`);
  console.log(`  Preço atual:  $${polPriceUSD.toFixed(6)}`);
  console.log(`  Range:        $${priceLower.toFixed(6)} – $${priceUpper.toFixed(6)} (±${RANGE_PCT*100}%)`);
  console.log(`  tickLower:    ${ticks.tickLower}`);
  console.log(`  tickUpper:    ${ticks.tickUpper}`);

  // Validar ticks (limites Uniswap V3: ±887272)
  if (ticks.tickLower < -887272 || ticks.tickUpper > 887272) {
    console.error(`❌ Ticks fora dos limites: [${ticks.tickLower}, ${ticks.tickUpper}]`);
    process.exit(1);
  }
  if (ticks.tickLower >= ticks.tickUpper) {
    console.error(`❌ tickLower (${ticks.tickLower}) >= tickUpper (${ticks.tickUpper})`);
    process.exit(1);
  }
  if (ticks.tickLower % TICK_SPACING !== 0 || ticks.tickUpper % TICK_SPACING !== 0) {
    console.error(`❌ Ticks não alinhados ao tick spacing ${TICK_SPACING}`);
    process.exit(1);
  }

  // ── Estimar gas ───────────────────────────────────────────────────────────
  const currentPriceRaw = ethers.parseUnits(polPriceUSD.toFixed(18), 18);

  const feeData  = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? ethers.parseUnits("35", "gwei");
  console.log(`\n  Gas price: ${ethers.formatUnits(gasPrice, "gwei")} gwei`);

  try {
    const gasEst = await keeper.openPosition.estimateGas(
      ticks.tickLower,
      ticks.tickUpper,
      0n,             // amount0Desired=0 → usar tudo
      0n,             // amount1Desired=0 → usar tudo
      currentPriceRaw
    );
    console.log(`  Gas estimado: ${gasEst.toLocaleString()} units`);
  } catch (e: any) {
    console.log(`  ⚠️  estimateGas falhou (${e.message.slice(0,60)}) — usando gasLimit manual`);
  }

  // ── Enviar openPosition ───────────────────────────────────────────────────
  console.log("\n🏊 Chamando openPosition()...");

  const tx = await keeper.openPosition(
    ticks.tickLower,
    ticks.tickUpper,
    0n,             // amount0Desired = 0 → contrato usa todo o saldo WPOL
    0n,             // amount1Desired = 0 → contrato usa todo o saldo USDC
    currentPriceRaw,
    {
      gasPrice,
      gasLimit: 1_500_000n,  // suficiente para mint na Uniswap V3
    }
  ) as ethers.ContractTransactionResponse;

  console.log(`  Tx enviada: ${tx.hash}`);
  console.log(`  🔗 https://polygonscan.com/tx/${tx.hash}`);

  const receipt = await tx.wait();

  if (receipt!.status === 1) {
    // Verificar posição aberta
    const newTokenId = await keeper.tokenId() as bigint;
    const newLiq     = await keeper.posLiquidity() as bigint;

    console.log(`\n${"━".repeat(52)}`);
    console.log(`✅ POSIÇÃO ABERTA COM SUCESSO!`);
    console.log(`${"━".repeat(52)}`);
    console.log(`  Bloco:      ${receipt!.blockNumber}`);
    console.log(`  Gas usado:  ${receipt!.gasUsed.toLocaleString()}`);
    console.log(`  tokenId:    ${newTokenId}`);
    console.log(`  Liquidity:  ${newLiq.toLocaleString()}`);
    console.log(`  Range:      $${priceLower.toFixed(5)} – $${priceUpper.toFixed(5)}`);
    console.log(`  Ticks:      [${ticks.tickLower}, ${ticks.tickUpper}]`);
    console.log(`\n  Próximo:    npm run start-server`);
    console.log(`${"━".repeat(52)}\n`);

  } else {
    console.error(`\n❌ Transação falhou (status=0)`);
    console.error(`  Hash: ${tx.hash}`);
    console.error(`  Verifique no PolygonScan: https://polygonscan.com/tx/${tx.hash}`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error("\n❌ Erro:", e.message ?? e);
  process.exit(1);
});
