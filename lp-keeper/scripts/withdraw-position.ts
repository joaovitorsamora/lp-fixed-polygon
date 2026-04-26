/**
 * recover-funds.ts — Recuperar fundos da posição fora do range
 *
 * Situação atual:
 * Contrato: 0xde95b32d6B0ff10C5Bcec9e13F41aCA94D352e67
 * Posição:  tokenId 2894156 — OUT OF RANGE
 * Preço atual: ~$0.092 WPOL/USDC
 *
 * Uso: npx ts-node scripts/recover-funds.ts
 */

import { ethers } from "ethers";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../.env") });

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURAÇÕES E ENDEREÇOS
// ─────────────────────────────────────────────────────────────────────────────

const CONTRACT    = process.env.KEEPER_CONTRACT ?? "0xde95b32d6B0ff10C5Bcec9e13F41aCA94D352e67";
const RPC_URL     = process.env.RPC_URL         ?? "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const WITHDRAW_TO = process.env.WITHDRAW_TO     ?? ""; 

const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const POOL = "0xb6e57ed85c4c9dbfef2a68711e9d6f36c56e0fcb"; 

// ─────────────────────────────────────────────────────────────────────────────
// ABIs
// ─────────────────────────────────────────────────────────────────────────────

const KEEPER_ABI = [
  "function tokenId() external view returns (uint256)",
  "function tickLower() external view returns (int24)",
  "function tickUpper() external view returns (int24)",
  "function posLiquidity() external view returns (uint128)",
  "function lastRebalanceTs() external view returns (uint256)",
  "function cooldownSeconds() external view returns (uint256)",
  "function keeper() external view returns (address)",
  "function owner() external view returns (address)",
  "function paused() external view returns (bool)",
  "function canRebalance() external view returns (bool ok, string memory reason)",
  "function rebalance(int24 newTickLower, int24 newTickUpper, uint256 currentPrice) external",
  "function harvest() external",
];

const ERC20_ABI = [
  "function balanceOf(address) external view returns (uint256)",
  "function transfer(address to, uint256 amount) external returns (bool)",
];

const POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function token0() external view returns (address)",
];

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÕES AUXILIARES
// ─────────────────────────────────────────────────────────────────────────────

async function getPolPrice(provider: ethers.JsonRpcProvider): Promise<number> {
  try {
    const pool = new ethers.Contract(POOL, POOL_ABI, provider);
    const [slot0, token0]: [any, string] = await Promise.all([pool.slot0(), pool.token0()]);
    
    const sqrtFloat = Number(BigInt(slot0.sqrtPriceX96.toString())) / 2 ** 96;
    const rawPrice  = sqrtFloat * sqrtFloat;
    const isWpolToken0 = token0.toLowerCase() === WPOL.toLowerCase();
    
    // Ajuste para 18 decimas (WPOL) vs 6 decimais (USDC) -> 10^12
    const polPrice = isWpolToken0 ? rawPrice / 1e12 : (1 / rawPrice) * 1e12;

    if (polPrice > 0.05 && polPrice < 5.0) {
      console.log(`  Preço on-chain: $${polPrice.toFixed(6)} POL/USD`);
      return polPrice;
    }
  } catch (err) {
    console.error("  Erro ao buscar preço on-chain, usando fallback.");
  }
  console.log("  Usando fallback: $0.092");
  return 0.092;
}

function calcCorrectTicks(polPrice: number, rangePct = 0.05) {
  const pricePool = polPrice * 1e12;
  const SPACING   = 10;
  
  const tL = Math.floor(Math.floor(Math.log(pricePool * (1 - rangePct)) / Math.log(1.0001)) / SPACING) * SPACING;
  const tU = Math.ceil(Math.ceil(Math.log(pricePool * (1 + rangePct)) / Math.log(1.0001)) / SPACING) * SPACING;
  
  return { tL, tU };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUÇÃO PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"━".repeat(60)}`);
  console.log(" 🔧 RECUPERAÇÃO DE FUNDOS — LP Manager");
  console.log(`${"━".repeat(60)}\n`);

  if (!PRIVATE_KEY) {
    console.error("❌ PRIVATE_KEY não definida no .env");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const keeper   = new ethers.Contract(CONTRACT, KEEPER_ABI, wallet);
  const wpol     = new ethers.Contract(WPOL, ERC20_ABI, wallet);
  const usdc     = new ethers.Contract(USDC, ERC20_ABI, wallet);

  // ── Estado atual ──────────────────────────────────────────────────────────
  console.log("📋 Consultando estado do contrato...");

  const [
    tokenId, tLower, tUpper, liq,
    lastTs, cooldownSecs, keeperAddr, ownerAddr, isPaused
  ] = await Promise.all([
    keeper.tokenId(),
    keeper.tickLower(),
    keeper.tickUpper(),
    keeper.posLiquidity(),
    keeper.lastRebalanceTs(),
    keeper.cooldownSeconds(),
    keeper.keeper(),
    keeper.owner(),
    keeper.paused(),
  ]);

  const wpolInContract = await wpol.balanceOf(CONTRACT);
  const usdcInContract = await usdc.balanceOf(CONTRACT);
  const polBalance     = await provider.getBalance(wallet.address);

  console.log(`  Contrato:      ${CONTRACT}`);
  console.log(`  Sua carteira:  ${wallet.address}`);
  console.log(`  É owner?       ${ownerAddr.toLowerCase() === wallet.address.toLowerCase() ? "✅ SIM" : "❌ NÃO"}`);
  console.log(`  tokenId:       ${tokenId}`);
  console.log(`  Ticks atuais:  [${tLower}, ${tUpper}]`);
  console.log(`  Liquidez:      ${liq.toString()}`);
  console.log(`  WPOL contrato: ${ethers.formatEther(wpolInContract)} WPOL`);
  console.log(`  USDC contrato: ${ethers.formatUnits(usdcInContract, 6)} USDC`);
  console.log(`  Gas (POL):     ${ethers.formatEther(polBalance)} POL`);

  if (keeperAddr.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error("\n❌ Erro: Sua carteira não tem permissão de Keeper.");
    process.exit(1);
  }

  // ── Cooldown ──────────────────────────────────────────────────────────────
  const now         = BigInt(Math.floor(Date.now() / 1000));
  const cooldownEnd = BigInt(lastTs) + BigInt(cooldownSecs);
  const remaining   = cooldownEnd > now ? Number(cooldownEnd - now) : 0;

  if (remaining > 0) {
    console.log(`\n⏳ Cooldown ativo: ${remaining}s restantes...`);
    await new Promise<void>(resolve => {
      const interval = setInterval(() => {
        const rem = Number(cooldownEnd) - Math.floor(Date.now() / 1000);
        if (rem <= 0) {
          clearInterval(interval);
          resolve();
        } else {
          process.stdout.write(`\r   Aguardando: ${rem}s ...    `);
        }
      }, 1000);
    });
    console.log("\n  ✅ Cooldown finalizado!");
  }

  // ── Cálculo e Rebalance ───────────────────────────────────────────────────
  const polPrice = await getPolPrice(provider);
  const { tL, tU } = calcCorrectTicks(polPrice, 0.05);
  const priceRaw = ethers.parseEther(polPrice.toString());

  console.log(`\n📐 Novos Ticks (±5%): [${tL}, ${tU}]`);
  
  const feeData = await provider.getFeeData();
  const tx = await keeper.rebalance(tL, tU, priceRaw, { 
    gasLimit: 1_500_000 
  });

  console.log(`🔄 Tx enviada: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`✅ Rebalance realizado com sucesso no bloco ${receipt.blockNumber}`);

  // ── Saque Opcional ────────────────────────────────────────────────────────
  if (process.env.WITHDRAW === "true") {
    const target = WITHDRAW_TO || wallet.address;
    console.log(`\n💸 Sacando fundos para: ${target}`);
    
    const finalWpol = await wpol.balanceOf(CONTRACT);
    const finalUsdc = await usdc.balanceOf(CONTRACT);

    if (finalWpol > 0n) {
      await (await wpol.transfer(target, finalWpol)).wait();
      console.log(`   Transferido: ${ethers.formatEther(finalWpol)} WPOL`);
    }
    if (finalUsdc > 0n) {
      await (await usdc.transfer(target, finalUsdc)).wait();
      console.log(`   Transferido: ${ethers.formatUnits(finalUsdc, 6)} USDC`);
    }
  }

  console.log(`\n${"━".repeat(60)}`);
  console.log(" ✅ PROCESSO FINALIZADO");
  console.log(`${"━".repeat(60)}\n`);
}

main().catch(e => {
  console.error("\n❌ Erro crítico:", e.message ?? e);
  process.exit(1);
});