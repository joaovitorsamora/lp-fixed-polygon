/**
 * deploy-and-fund.ts — Deploy + Wrap POL + Transferir tokens + Abrir posição
 *
 * Executa tudo em sequência, em uma única chamada:
 *   1. Verifica saldos reais (POL nativo + USDC)
 *   2. Faz o cálculo de alocação (reserva gas, divide restante)
 *   3. Deploy do LPKeeper.sol
 *   4. Wrap de POL nativo → WPOL (ERC-20)
 *   5. Transfere WPOL ao contrato
 *   6. Transfere USDC ao contrato
 *   7. Chama openPosition() com os ticks calculados do preço atual
 *   8. Atualiza o .env com o novo KEEPER_CONTRACT
 *
 * Saldo atual:
 *   POL nativo:  1.953 (~$0.18 a $0.093/POL)
 *   USDC:        0.436
 *   Total LP:    ~$0.57
 *
 * Reserva de gas: 0.5 POL (suficiente para ~100 rebalances a $0.003/tx)
 * Para LP:       1.453 POL wrapeado → WPOL + 0.436 USDC
 *
 * Uso:
 *   npm run deploy:polygon      ← mainnet real
 *   npm run deploy:amoy         ← testnet
 *
 * Pré-requisitos (.env):
 *   PRIVATE_KEY=0x...
 *   RPC_URL=https://polygon-rpc.com
 *   CHAIN_ID=137
 */

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "../.env") });

// ─────────────────────────────────────────────────────────────────────────────
// Endereços Polygon Mainnet (imutáveis)
// ─────────────────────────────────────────────────────────────────────────────

const ADDRESSES = {
  // WPOL = wrapper do POL nativo (equivalente ao WETH na Ethereum)
  WPOL: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  // USDC nativo na Polygon (não bridged)
  USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  // NonfungiblePositionManager da Uniswap V3 (mesmo endereço em todas as redes)
  NPM:  "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
};

// ABI do WPOL (WMATIC) — tem deposit() que converte POL nativo → ERC-20
const WPOL_ABI = [
  "function deposit() external payable",
  "function withdraw(uint256 amount) external",
  "function balanceOf(address account) external view returns (uint256)",
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function approve(address spender, uint256 amount) external returns (bool)",
];

const ERC20_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function decimals() external view returns (uint8)",
];

// ABI mínimo do pool Uniswap V3 para ler o preço atual
const POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
];

// ─────────────────────────────────────────────────────────────────────────────
// Configuração de rede
// ─────────────────────────────────────────────────────────────────────────────

const NETWORKS: Record<string, {
  rpcUrl: string; chainId: number; name: string;
  polPrice: number; // preço estimado para cálculo — buscado on-chain depois
  poolAddress: string; // pool WPOL/USDC para leitura de preço
}> = {
  polygon: {
    rpcUrl:      process.env.RPC_URL ?? "https://polygon-rpc.com",
    chainId:     137,
    name:        "Polygon Mainnet",
    polPrice:    0.093, // fallback — será atualizado via slot0
    poolAddress: "0xa374094527e1673a86de625aa59517c5de346d32",
  },
  amoy: {
    rpcUrl:      process.env.AMOY_RPC_URL ?? "https://rpc-amoy.polygon.technology",
    chainId:     80002,
    name:        "Polygon Amoy Testnet",
    polPrice:    0.093,
    poolAddress: "0x0000000000000000000000000000000000000001", // não existe em testnet
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Calcular ticks a partir do preço atual + range desejado
// ─────────────────────────────────────────────────────────────────────────────

function priceToTick(price: number): number {
  return Math.floor(Math.log(price) / Math.log(1.0001));
}

function alignTick(tick: number, spacing: number, direction: "floor" | "ceil"): number {
  return direction === "floor"
    ? Math.floor(tick / spacing) * spacing
    : Math.ceil(tick  / spacing) * spacing;
}

function calcTickRange(
  polPriceUSD: number,
  rangePct:    number = 0.05, // ±5% do preço atual
  tickSpacing: number = 10
): { tickLower: number; tickUpper: number; lower: number; upper: number } {
  // Na pool WPOL/USDC: token0=WPOL(18dec), token1=USDC(6dec)
  // price = token1/token0 = USDC/WPOL = preço do POL em USDC
  // Mas a fórmula sqrtPriceX96 dá token1/token0 com ajuste de decimais:
  // price_pool = (sqrtPriceX96 / 2^96)^2 * 10^(dec0 - dec1) = ... / 10^12
  // Para simplificar: tick = log(1/polPrice * 10^(18-6)) / log(1.0001)
  const adjustedPrice = (1 / polPriceUSD) * 1e12; // ajuste de decimais (18-6=12)
  const centerTick     = priceToTick(adjustedPrice);
  const lowerPrice     = adjustedPrice * (1 - rangePct);
  const upperPrice     = adjustedPrice * (1 + rangePct);
  const rawLower       = priceToTick(lowerPrice);
  const rawUpper       = priceToTick(upperPrice);
  const tickLower      = alignTick(rawLower, tickSpacing, "floor");
  const tickUpper      = alignTick(rawUpper, tickSpacing, "ceil");

  return {
    tickLower,
    tickUpper,
    lower:  1 / (lowerPrice / 1e12),
    upper:  1 / (upperPrice / 1e12),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Buscar preço real do pool on-chain
// ─────────────────────────────────────────────────────────────────────────────

async function fetchPoolPrice(
  provider: ethers.JsonRpcProvider,
  poolAddress: string
): Promise<number> {
  try {
    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
    const slot0 = await pool.slot0();
    const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96);
    
    // If sqrtPriceX96 is 0, pool is not initialized
    if (sqrtPriceX96 === 0n) {
      console.log("  Pool não inicializado — usando preço fallback $0.094");
      return 0.094;
    }
    
    // WPOL=token0 (18dec), USDC=token1 (6dec)
    // rawPrice = (sqrt/2^96)^2 → price em token1/token0 sem ajuste de decimais
    const rawPrice = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
    // ajuste de decimais: * 10^(dec1 - dec0) = * 10^(6-18) = / 10^12
    const poolPrice = rawPrice / 1e12;  // USDC por WPOL
    
    // If price is 0 or very small, use fallback
    if (poolPrice < 0.001) {
      console.log("  Preço muito baixo — usando preço fallback $0.094");
      return 0.094;
    }
    
    console.log(`  Preço on-chain do pool: $${poolPrice.toFixed(6)} USD/POL`);
    return poolPrice;
  } catch (err: any) {
    console.log(`  Erro ao ler preço on-chain: ${err.message} — usando fallback $0.094`);
    return 0.094;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: aguardar tx com log
// ─────────────────────────────────────────────────────────────────────────────

async function sendAndWait(
  tx:    ethers.ContractTransactionResponse,
  label: string
): Promise<ethers.TransactionReceipt> {
  console.log(`  ⏳ ${label}...`);
  const receipt = await tx.wait();
  console.log(`  ✅ ${label} | bloco: ${receipt!.blockNumber} | gas: ${receipt!.gasUsed.toLocaleString()}`);
  return receipt!;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const networkKey = process.env.NETWORK ?? "polygon";
  const net = NETWORKS[networkKey];
  if (!net) {
    console.error(`Rede desconhecida: "${networkKey}". Use: polygon | amoy`);
    process.exit(1);
  }

  console.log(`\n${"━".repeat(54)}`);
  console.log(`🚀 LP Manager — Deploy & Fund`);
  console.log(`   Rede: ${net.name} (${net.chainId})`);
  console.log(`${"━".repeat(54)}\n`);

  // ── Provider e carteira ─────────────────────────────────────────────────
  const provider = new ethers.JsonRpcProvider(net.rpcUrl);
  const pk = process.env.PRIVATE_KEY;
  if (!pk) { console.error("❌ PRIVATE_KEY não definida no .env"); process.exit(1); }

  const wallet   = new ethers.Wallet(pk, provider);
  const keeperAddr = (process.env.KEEPER && process.env.KEEPER.trim()) || wallet.address;

  // ── Verificar saldos iniciais ───────────────────────────────────────────
  console.log("📊 Verificando saldos...");
  const polBalRaw  = await provider.getBalance(wallet.address);
  const polBal     = parseFloat(ethers.formatEther(polBalRaw));

  const usdcContract  = new ethers.Contract(ADDRESSES.USDC, ERC20_ABI, wallet);
  const usdcBalRaw    = await usdcContract.balanceOf(wallet.address) as bigint;
  const usdcBal       = parseFloat(ethers.formatUnits(usdcBalRaw, 6));

  const wpolContract  = new ethers.Contract(ADDRESSES.WPOL, ERC20_ABI, wallet);
  const wpolBalRaw    = await wpolContract.balanceOf(wallet.address) as bigint;
  const wpolBal       = parseFloat(ethers.formatEther(wpolBalRaw));

  console.log(`   Carteira: ${wallet.address}`);
  console.log(`   POL nativo:  ${polBal.toFixed(6)} POL`);
  console.log(`   WPOL (ERC-20): ${wpolBal.toFixed(6)} WPOL`);
  console.log(`   USDC:        ${usdcBal.toFixed(6)} USDC`);

  // Validação mínima
  if (polBal < 0.05) {
    console.error(`\n❌ Saldo de POL insuficiente (${polBal.toFixed(4)}). Mínimo: 0.05 POL para gas.`);
    process.exit(1);
  }

  // ── Buscar preço real on-chain ──────────────────────────────────────────
  console.log("\n💱 Buscando preço atual do pool...");
  const polPriceUSD = await fetchPoolPrice(provider, net.poolAddress);

  // ── Calcular alocação ───────────────────────────────────────────────────
  //
  // Estratégia de alocação:
  //   - Reservar 0.5 POL nativo para gas das operações futuras do bot
  //   - Converter o restante do POL nativo → WPOL
  //   - USDC fica como está (não precisa converter)
  //   - Total LP = WPOL convertido + USDC já disponível
  //
  const GAS_RESERVE_POL = 0.5;
  const polToWrap       = Math.max(0, polBal - GAS_RESERVE_POL);
  const polToWrapWei    = ethers.parseEther(polToWrap.toFixed(18));
  const totalLPusd      = (polToWrap + wpolBal) * polPriceUSD + usdcBal;

  console.log(`\n📐 Alocação calculada:`);
  console.log(`   Reserva gas:       ${GAS_RESERVE_POL} POL nativo (para ~${Math.floor(GAS_RESERVE_POL / 0.005)} rebalances)`);
  console.log(`   POL → WPOL:        ${polToWrap.toFixed(6)} POL → WPOL`);
  console.log(`   WPOL já existente: ${wpolBal.toFixed(6)} WPOL`);
  console.log(`   USDC existente:    ${usdcBal.toFixed(6)} USDC`);
  console.log(`   Capital total LP:  ~$${totalLPusd.toFixed(4)} USD`);

  if (polToWrap <= 0 && wpolBal === 0 && usdcBal === 0) {
    console.error("\n❌ Nenhum capital disponível para LP após reserva de gas.");
    process.exit(1);
  }

  // Confirmação
  console.log(`\n⚠️  Este script vai:`);
  console.log(`   1. Deployar LPKeeper.sol na ${net.name}`);
  if (polToWrap > 0) console.log(`   2. Wrappear ${polToWrap.toFixed(6)} POL → WPOL`);
  if (wpolBal > 0 || polToWrap > 0) console.log(`   3. Transferir WPOL ao contrato`);
  if (usdcBal > 0) console.log(`   4. Transferir ${usdcBal.toFixed(6)} USDC ao contrato`);
  console.log(`   5. Abrir posição LP (±5% do preço atual)`);
  console.log(`   6. Atualizar KEEPER_CONTRACT no .env`);
  console.log(`\n   Pressione Ctrl+C para cancelar ou aguarde 5s...\n`);
  await new Promise(r => setTimeout(r, 5_000));

  // ── 1. DEPLOY ────────────────────────────────────────────────────────────

  console.log("📦 Passo 1/5 — Deploy do LPKeeper.sol...");

  const artifactPath = path.join(__dirname, "../artifacts/LPKeeper.json");
  if (!fs.existsSync(artifactPath)) {
    console.error(`❌ Artifact não encontrado: ${artifactPath}`);
    console.error("   Execute: npm run compile");
    process.exit(1);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const factory  = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const feeData  = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? ethers.parseUnits("35", "gwei");

  console.log(`   Gas price: ${ethers.formatUnits(gasPrice, "gwei")} gwei`);

  const deployTx    = await factory.getDeployTransaction(keeperAddr, { gasPrice });
  const deployGas   = await provider.estimateGas({ ...deployTx, from: wallet.address });
  const deployGasPOL = parseFloat(ethers.formatEther(deployGas * gasPrice));
  console.log(`   Gas estimado deploy: ${deployGas.toLocaleString()} units (~${deployGasPOL.toFixed(5)} POL)`);

  const contract = await factory.deploy(keeperAddr, { gasPrice });
  const deployReceipt = await contract.deploymentTransaction()!.wait();
  const contractAddress = await contract.getAddress();

  console.log(`   ✅ LPKeeper deployado: ${contractAddress}`);
  if (networkKey === "polygon") {
    console.log(`   🔗 https://polygonscan.com/address/${contractAddress}`);
  }

  // ── 2. WRAP POL → WPOL ──────────────────────────────────────────────────

  let wpolToSend = wpolBalRaw; // WPOL já existente na carteira

  if (polToWrap > 0) {
    console.log(`\n🔄 Passo 2/5 — Wrap ${polToWrap.toFixed(6)} POL → WPOL...`);
    const wpol = new ethers.Contract(ADDRESSES.WPOL, WPOL_ABI, wallet);
    const wrapTx = await wpol.deposit({ value: polToWrapWei, gasPrice });
    await sendAndWait(wrapTx, `Wrap ${polToWrap.toFixed(6)} POL → WPOL`);

    // Verificar saldo WPOL atualizado
    const newWpolBal = await wpolContract.balanceOf(wallet.address) as bigint;
    wpolToSend = newWpolBal;
    console.log(`   WPOL disponível: ${ethers.formatEther(wpolToSend)} WPOL`);
  } else {
    console.log(`\n⏭️  Passo 2/5 — Sem POL para converter (reserva=$${GAS_RESERVE_POL} POL mantida)`);
  }

  // ── 3. TRANSFERIR WPOL AO CONTRATO ────────────────────────────────────────

  if (wpolToSend > 0n) {
    console.log(`\n📤 Passo 3/5 — Transferindo WPOL ao contrato...`);
    const wpol = new ethers.Contract(ADDRESSES.WPOL, WPOL_ABI, wallet);
    const transferWpol = await wpol.transfer(contractAddress, wpolToSend, { gasPrice });
    await sendAndWait(transferWpol, `Transfer ${ethers.formatEther(wpolToSend)} WPOL → contrato`);
  } else {
    console.log(`\n⏭️  Passo 3/5 — Nenhum WPOL para transferir`);
  }

  // ── 4. TRANSFERIR USDC AO CONTRATO ────────────────────────────────────────

  if (usdcBalRaw > 0n) {
    console.log(`\n📤 Passo 4/5 — Transferindo ${usdcBal.toFixed(6)} USDC ao contrato...`);
    const transferUsdc = await usdcContract.transfer(contractAddress, usdcBalRaw, { gasPrice });
    await sendAndWait(transferUsdc, `Transfer ${usdcBal.toFixed(6)} USDC → contrato`);
  } else {
    console.log(`\n⏭️  Passo 4/5 — Nenhum USDC para transferir`);
  }

  // ── 5. ABRIR POSIÇÃO LP ───────────────────────────────────────────────────

  console.log(`\n🏊 Passo 5/5 — Abrindo posição LP...`);

  // Verificar saldo no contrato
  const contractWpol = await wpolContract.balanceOf(contractAddress) as bigint;
  const contractUsdc = await usdcContract.balanceOf(contractAddress) as bigint;

  console.log(`   Saldo contrato — WPOL: ${ethers.formatEther(contractWpol)} | USDC: ${ethers.formatUnits(contractUsdc, 6)}`);

  if (contractWpol === 0n && contractUsdc === 0n) {
    console.error("   ❌ Contrato sem saldo. As transferências falharam.");
    process.exit(1);
  }

  // Calcular ticks do range ±5%
  const range = calcTickRange(polPriceUSD, 0.05, 10);
  console.log(`   Preço atual: $${polPriceUSD.toFixed(6)}`);
  console.log(`   Range: $${range.lower.toFixed(6)} – $${range.upper.toFixed(6)} (±5%)`);
  console.log(`   Ticks: [${range.tickLower}, ${range.tickUpper}]`);

  // Chamar openPosition no contrato deployado
  const keeper = new ethers.Contract(contractAddress, artifact.abi, wallet);
  const currentPriceRaw = ethers.parseUnits(polPriceUSD.toFixed(18), 18);

  // Verificar se já existe posição
  try {
    const existingPos = await keeper.getPosition();
    console.log(`   Posição atual: tickLower=${existingPos.tickLower}, tickUpper=${existingPos.tickUpper}, liquidity=${existingPos.liquidity}`);
    if (existingPos.liquidity > 0n) {
      console.log(`   ⚠️ Contrato já tem posição! Pulando openPosition...`);
    } else {
      // amount0Desired=0, amount1Desired=0 → contrato usa 100% do saldo disponível
      const openTx = await keeper.openPosition(
        range.tickLower,
        range.tickUpper,
        0n,           // amount0Desired = 0 → usar tudo
        0n,           // amount1Desired = 0 → usar tudo
        currentPriceRaw,
        { gasPrice, gasLimit: 1_500_000 }
      );
      await sendAndWait(openTx, "openPosition()");
    }
  } catch (err: any) {
    console.log(`   Erro ao verificar posição: ${err.message}`);
    // Tentar abrir posição mesmo assim
    const openTx = await keeper.openPosition(
      range.tickLower,
      range.tickUpper,
      0n,
      0n,
      currentPriceRaw,
      { gasPrice, gasLimit: 1_500_000 }
    );
    await sendAndWait(openTx, "openPosition()");
  }

  // ── 6. ATUALIZAR .ENV ─────────────────────────────────────────────────────

  console.log(`\n📝 Atualizando .env...`);
  const envPath = path.join(__dirname, "../.env");
  let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";

  const update = (key: string, value: string) => {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `${key}=${value}`);
    } else {
      envContent += `\n${key}=${value}`;
    }
  };

  update("KEEPER_CONTRACT", contractAddress);
  update("CHAIN_ID",        String(net.chainId));
  update("DRY_RUN",         "false");

  fs.writeFileSync(envPath, envContent.trim() + "\n");
  console.log(`   ✅ KEEPER_CONTRACT=${contractAddress} salvo no .env`);

  // ── Salvar deployment.json ────────────────────────────────────────────────

  const deployment = {
    network:      net.name,
    chainId:      net.chainId,
    address:      contractAddress,
    deployedAt:   new Date().toISOString(),
    deployer:     wallet.address,
    keeper:       keeperAddr,
    initialFunds: {
      wpolWei:  wpolToSend.toString(),
      usdcRaw:  usdcBalRaw.toString(),
      polPriceUSD,
      totalUSD: totalLPusd,
    },
    position: {
      tickLower:   range.tickLower,
      tickUpper:   range.tickUpper,
      lowerPriceUSD: range.lower,
      upperPriceUSD: range.upper,
    },
  };

  const outFile = path.join(__dirname, `../deployment.${networkKey}.json`);
  fs.writeFileSync(outFile, JSON.stringify(deployment, null, 2));

  // ── Resultado final ───────────────────────────────────────────────────────

  const polFinal = parseFloat(ethers.formatEther(await provider.getBalance(wallet.address)));

  console.log(`\n${"━".repeat(54)}`);
  console.log(`✅ DEPLOY & FUND CONCLUÍDO`);
  console.log(`${"━".repeat(54)}`);
  console.log(`   Contrato:      ${contractAddress}`);
  console.log(`   PolygonScan:   https://polygonscan.com/address/${contractAddress}`);
  console.log(`   Capital LP:    ~$${totalLPusd.toFixed(4)}`);
  console.log(`   POL restante:  ${polFinal.toFixed(4)} POL (gas futuro)`);
  console.log(`   Range ativo:   $${range.lower.toFixed(5)} – $${range.upper.toFixed(5)}`);
  console.log(`\n   Próximo passo: npm run start-server`);
  console.log(`${"━".repeat(54)}\n`);
}

main().catch(e => {
  console.error("\n❌ Falhou:", e.message ?? e);
  process.exit(1);
});
