// scripts/rebalance-centered.ts
//
// Reposiciona o range com o preço EXATAMENTE no centro.
//
// Fixes em relação ao rebalance-asymmetric.ts:
//
// 1. currentPrice corrigido:
//    O contrato guarda currentPrice só para tracking — não afeta o slippage.
//    Mas o valor passado deve ser o preço em USD * 1e18 (simples).
//    priceFromTick() já dá USDC/WMATIC com ajuste 1e12, então:
//    currentPriceUSD = 1 / (priceFromTick(tick) / 1e12) ... não.
//    Na verdade: tick do pool WMATIC/USDC dá price = USDC/WMATIC * 1e12
//    Então polPriceUSD = Math.pow(1.0001, tick) / 1e12... não.
//    Forma correta: sqrtPriceX96 → rawPrice → / 1e12 = USD/WMATIC.
//    Passamos como uint256: Math.round(polPriceUSD * 1e18).
//
// 2. Slippage zerado temporariamente para o rebalance:
//    A posição tem 98.58% WMATIC e 1.42% USDC.
//    Ao rebalancear para range centrado (50/50), a Uniswap vai usar
//    mais USDC do que temos. O amount1Min com slippage 1% rejeita
//    porque a Uniswap retorna menos USDC do que amount1Desired.
//    SOLUÇÃO: setar slippage = 0 antes, rebalancear, restaurar depois.
//    (owner = keeper = sua carteira, então pode chamar setSlippageBps)
//
// 3. Range centrado puro: tickLower = center - HALF, tickUpper = center + HALF

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const CONTRACT = process.env.KEEPER_CONTRACT!;

const contract = new ethers.Contract(
  CONTRACT,
  [
    "function rebalance(int24,int24,uint256) external",
    "function setSlippageBps(uint256) external",
    "function slippageBps() view returns (uint256)",
    "function cooldownSeconds() view returns (uint256)",
    "function lastRebalanceTs() view returns (uint256)",
    "function keeper() view returns (address)",
    "function owner() view returns (address)",
    "function tokenId() view returns (uint256)",
    "function tickLower() view returns (int24)",
    "function tickUpper() view returns (int24)",
  ],
  wallet
);

const POOL = new ethers.Contract(
  "0xB6e57ed85c4c9dbfEF2a68711e9d6f36c56e0FcB",
  ["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)"],
  provider
);

const SPACING = 10;
// Largura total do range em ticks.
// 500 ticks de cada lado = ~5% de cada lado do centro.
// Com tick spacing 10 e WMATIC ~$0.092:
//   1 tick ≈ 0.01% de variação de preço
//   500 ticks ≈ 5% de variação → range de ±5% centrado no preço atual
const HALF_WIDTH = 500;

async function getPolPriceFromSlot0(): Promise<{ polPriceUSD: number; currentTick: number }> {
  const slot0 = await POOL.slot0();
  const sqrtPriceX96 = BigInt(slot0[0].toString());
  const currentTick  = Number(slot0[1]);

  // sqrtPriceX96: encode price = token1/token0 sem ajuste de decimais
  // token0 = WMATIC (18 dec), token1 = USDC (6 dec)
  // rawPrice = (sqrtPriceX96 / 2^96)^2
  // polPriceUSD = rawPrice * 10^(dec1-dec0) = rawPrice / 10^12
  const sqrtFloat   = Number(sqrtPriceX96) / (2 ** 96);
  const rawPrice    = sqrtFloat * sqrtFloat;
  const polPriceUSD = rawPrice / 1e12;

  return { polPriceUSD, currentTick };
}

async function main() {
  console.log("━".repeat(52));
  console.log("🎯 Rebalance Centrado — WMATIC/USDC");
  console.log("━".repeat(52));

  // ── Verificar quem está chamando ──────────────────────────────────────────
  const [keeperAddr, ownerAddr, currentTokenId, currentTL, currentTU] = await Promise.all([
    contract.keeper(),
    contract.owner(),
    contract.tokenId(),
    contract.tickLower(),
    contract.tickUpper(),
  ]);

  console.log(`\nContrato:  ${CONTRACT}`);
  console.log(`Carteira:  ${wallet.address}`);
  console.log(`É keeper?  ${keeperAddr.toLowerCase() === wallet.address.toLowerCase() ? "✅" : "❌"}`);
  console.log(`É owner?   ${ownerAddr.toLowerCase() === wallet.address.toLowerCase() ? "✅" : "❌"}`);
  console.log(`tokenId:   ${currentTokenId}`);
  console.log(`Ticks atuais: [${currentTL}, ${currentTU}]`);

  if (keeperAddr.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error("❌ Sua carteira não é keeper. Abortando.");
    process.exit(1);
  }

  // ── Cooldown ──────────────────────────────────────────────────────────────
  const [cooldown, lastTs] = await Promise.all([
    contract.cooldownSeconds(),
    contract.lastRebalanceTs(),
  ]);

  const now       = BigInt(Math.floor(Date.now() / 1000));
  const remaining = Number(lastTs) + Number(cooldown) - Number(now);

  if (remaining > 0) {
    console.log(`\n⏳ Cooldown ativo: ${remaining}s (~${Math.ceil(remaining/60)}min)`);
    console.log("   Aguardando...");
    await new Promise<void>(r => {
      const iv = setInterval(() => {
        const rem = Number(lastTs) + Number(cooldown) - Math.floor(Date.now()/1000);
        if (rem <= 0) { clearInterval(iv); console.log(""); r(); }
        else process.stdout.write(`\r   ${rem}s restantes...   `);
      }, 1000);
    });
  }

  // ── Preço atual on-chain ──────────────────────────────────────────────────
  console.log("\n💱 Lendo preço on-chain...");
  const { polPriceUSD, currentTick } = await getPolPriceFromSlot0();
  console.log(`   Tick atual:   ${currentTick}`);
  console.log(`   POL price:    $${polPriceUSD.toFixed(6)}`);

  // ── Calcular range centrado ───────────────────────────────────────────────
  // Alinhar o centro ao tick spacing
  const centerTick = Math.round(currentTick / SPACING) * SPACING;
  const tickLower  = centerTick - HALF_WIDTH;
  const tickUpper  = centerTick + HALF_WIDTH;

  // Verificar alinhamento
  if (tickLower % SPACING !== 0 || tickUpper % SPACING !== 0) {
    console.error(`❌ Ticks não alinhados: [${tickLower}, ${tickUpper}]`);
    process.exit(1);
  }

  // Preço do range em USD
  // priceInPool = 1.0001^tick, polPriceUSD = priceInPool / 1e12
  const priceLowerUSD = Math.pow(1.0001, tickLower) / 1e12;
  const priceUpperUSD = Math.pow(1.0001, tickUpper) / 1e12;
  const rangePctBelow = ((polPriceUSD - priceLowerUSD) / polPriceUSD * 100).toFixed(1);
  const rangePctAbove = ((priceUpperUSD - polPriceUSD) / polPriceUSD * 100).toFixed(1);

  console.log(`\n📐 Novo range centrado:`);
  console.log(`   centerTick:  ${centerTick}`);
  console.log(`   tickLower:   ${tickLower}  ($${priceLowerUSD.toFixed(5)}, -${rangePctBelow}%)`);
  console.log(`   tickUpper:   ${tickUpper}  ($${priceUpperUSD.toFixed(5)}, +${rangePctAbove}%)`);
  console.log(`   Preço atual: $${polPriceUSD.toFixed(5)} ← centro`);

  // currentPrice para o contrato (só tracking — uint256 em USD * 1e18)
  const currentPriceRaw = BigInt(Math.round(polPriceUSD * 1e18));

  // ── Setar slippage = 0 para evitar o "Price slippage check" ──────────────
  // Necessário porque a posição está 98.58% WMATIC, 1.42% USDC.
  // Ao rebalancear para 50/50, o amount1Min (USDC) com slippage 1%
  // fica maior que o USDC que a Uniswap consegue alocar, causando revert.
  // Slippage 0 significa min0=0 e min1=0 → aceita qualquer proporção.
  const currentSlip = await contract.slippageBps();
  console.log(`\n⚙️  Slippage atual: ${currentSlip} bps`);

  if (currentSlip !== 0n) {
    console.log("   Zerando slippage temporariamente...");
    const tx0 = await contract.setSlippageBps(0, {
      gasLimit: 100_000n,
    });
    await tx0.wait();
    console.log("   ✅ slippageBps = 0");
  }

  // ── Estimar gas ───────────────────────────────────────────────────────────
  const feeData  = await provider.getFeeData();
  const gasPrice = feeData.gasPrice!;
  console.log(`\n   Gas price: ${ethers.formatUnits(gasPrice, "gwei")} gwei`);

  let gasLimit = 1_500_000n;
  try {
    const est = await contract.rebalance.estimateGas(tickLower, tickUpper, currentPriceRaw);
    gasLimit  = est * 130n / 100n;
    console.log(`   Gas estimado: ${est.toLocaleString()} (limit: ${gasLimit.toLocaleString()})`);
  } catch (e: any) {
    console.log(`   ⚠️  estimateGas falhou (${e.shortMessage ?? e.message.slice(0, 60)})`);
    console.log(`   Usando gasLimit manual: ${gasLimit.toLocaleString()}`);
  }

  // ── Rebalance ─────────────────────────────────────────────────────────────
  console.log("\n🔄 Enviando rebalance()...");
  const tx = await contract.rebalance(
    tickLower,
    tickUpper,
    currentPriceRaw,
    { gasPrice, gasLimit }
  );

  console.log(`   Tx: ${tx.hash}`);
  console.log(`   🔗 https://polygonscan.com/tx/${tx.hash}`);

  const receipt = await tx.wait();

  if (receipt.status !== 1) {
    console.error("❌ Rebalance falhou. Veja o PolygonScan.");
    // Restaurar slippage mesmo em caso de erro
    await contract.setSlippageBps(100, { gasLimit: 100_000n });
    process.exit(1);
  }

  console.log(`   ✅ Rebalance OK | bloco: ${receipt.blockNumber} | gas: ${receipt.gasUsed.toLocaleString()}`);

  // ── Restaurar slippage = 100 (1%) ─────────────────────────────────────────
  console.log("\n⚙️  Restaurando slippage para 100 bps (1%)...");
  const txR = await contract.setSlippageBps(100, { gasLimit: 100_000n });
  await txR.wait();
  console.log("   ✅ slippageBps = 100");

  // ── Resultado final ───────────────────────────────────────────────────────
  console.log(`\n${"━".repeat(52)}`);
  console.log("✅ RANGE RECENTRADO");
  console.log(`${"━".repeat(52)}`);
  console.log(`   Preço atual: $${polPriceUSD.toFixed(5)}`);
  console.log(`   Range:       $${priceLowerUSD.toFixed(5)} – $${priceUpperUSD.toFixed(5)}`);
  console.log(`   Ticks:       [${tickLower}, ${tickUpper}]`);
  console.log(`   Revert:      https://revert.finance/#/account/${wallet.address}/polygon`);
  console.log(`${"━".repeat(52)}\n`);
}

main().catch(e => {
  console.error("\n❌", e.shortMessage ?? e.message ?? e);
  process.exit(1);
});