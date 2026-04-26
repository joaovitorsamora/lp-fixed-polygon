// scripts/withdraw-all.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const KEEPER_CONTRACT = "0xde95b32d6B0ff10C5Bcec9e13F41aCA94D352e67"; // contrato CORRETO
const NPM  = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const TOKEN_ID = 2894165;

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

// Chamadas diretas no NPM — agora com a wallet como operador aprovado
// O contrato 0xde95 é o owner do NFT, então precisamos ir via contrato
const contract = new ethers.Contract(KEEPER_CONTRACT, [
  "function owner() view returns (address)",
  "function keeper() view returns (address)",
  "function tokenId() view returns (uint256)",
  "function paused() view returns (bool)",
  "function cooldownSeconds() view returns (uint256)",
  "function lastRebalanceTs() view returns (uint256)",
  "function keeperEthReserve() view returns (uint256)",
  "function rebalance(int24,int24,uint256) external",
  "function harvest() external",
], wallet);

const erc20 = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) external returns (bool)",
];
const wpol = new ethers.Contract(WPOL, erc20, wallet);
const usdc  = new ethers.Contract(USDC, erc20, wallet);

const npm = new ethers.Contract(NPM, [
  "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
], provider);

async function main() {
  console.log("=== DIAGNÓSTICO DO CONTRATO CORRETO ===");

  const [owner, keeper, tokenId, paused, cooldown, lastReb, keeperReserve] = await Promise.all([
    contract.owner(),
    contract.keeper(),
    contract.tokenId(),
    contract.paused(),
    contract.cooldownSeconds(),
    contract.lastRebalanceTs(),
    contract.keeperEthReserve(),
  ]);

  console.log("owner:      ", owner);
  console.log("keeper:     ", keeper);
  console.log("tokenId:    ", tokenId.toString());
  console.log("paused:     ", paused);

  const keeperPol = await provider.getBalance(keeper);
  console.log("keeper POL: ", ethers.formatEther(keeperPol),
    keeperPol >= keeperReserve ? "✅" : "❌ insuficiente");

  const now = BigInt(Math.floor(Date.now() / 1000));
  const cooldownLeft = (lastReb + cooldown) > now ? (lastReb + cooldown) - now : 0n;
  console.log("cooldown restante:", cooldownLeft.toString(), "s");

  const pos = await npm.positions(TOKEN_ID);
  const liquidity: bigint = pos[7];
  console.log("liquidity no NPM: ", liquidity.toString());

  // Verificar saldo ERC20 no contrato
  const [wpolBal, usdcBal] = await Promise.all([
    wpol.balanceOf(KEEPER_CONTRACT),
    usdc.balanceOf(KEEPER_CONTRACT),
  ]);
  console.log("WPOL no contrato: ", ethers.formatEther(wpolBal));
  console.log("USDC no contrato: ", ethers.formatUnits(usdcBal, 6));

  // Parar se algo bloquear
  if (paused)         { console.error("❌ Contrato pausado"); process.exit(1); }
  if (cooldownLeft > 0n) { console.error(`❌ Cooldown ativo: ${cooldownLeft}s`); process.exit(1); }
  if (keeperPol < keeperReserve) { console.error("❌ Keeper sem POL suficiente"); process.exit(1); }
  if (tokenId === 0n) { console.error("❌ tokenId=0 no contrato — posição não registrada"); process.exit(1); }

  // ── PASSO 1: harvest para garantir que fees pendentes sejam coletadas
  console.log("\n🌾 Passo 1/4 — Coletando fees pendentes (harvest)...");
  try {
    const txH = await contract.harvest({ gasLimit: 300_000 });
    console.log("TX harvest:", txH.hash);
    await txH.wait();
    console.log("✅ Harvest ok");
  } catch (e: any) {
    console.log("⚠️  Harvest falhou (pode não ter fees pendentes):", e.shortMessage || e.message);
  }

  // ── PASSO 2: rebalance com ticks "inválidos" não funciona — 
  //    vamos usar rebalance para os MESMOS ticks, forçando collect+burn+mint
  //    Isso devolve os tokens pro contrato, depois transferimos
  const { tickLower, tickUpper } = require("../deployment.polygon.json").position;
  
  console.log(`\n🔄 Passo 2/4 — Removendo posição via rebalance (ticks: ${tickLower} → ${tickUpper})...`);
  
  // Preço atual aproximado de POL/USDC (inverso do pool)
  // tickLower=299450 → preço ~0.099 USD/POL → currentPrice em formato raw (18 decimais)
  const currentPrice = ethers.parseUnits("0.094", 18); // preço aproximado POL agora

  try {
    const txR = await contract.rebalance(
      tickLower,
      tickUpper,
      currentPrice,
      { gasLimit: 800_000 }
    );
    console.log("TX rebalance:", txR.hash);
    await txR.wait();
    console.log("✅ Rebalance ok — tokens voltaram pro contrato");
  } catch (e: any) {
    console.error("❌ Rebalance falhou:", e.shortMessage || e.message);
    console.error("   Tente ajustar o currentPrice ou verificar tick spacing");
    process.exit(1);
  }

  // ── PASSO 3: verificar saldo após rebalance
  console.log("\n💰 Passo 3/4 — Saldo no contrato após rebalance:");
  const [wpolAfter, usdcAfter] = await Promise.all([
    wpol.balanceOf(KEEPER_CONTRACT),
    usdc.balanceOf(KEEPER_CONTRACT),
  ]);
  console.log("WPOL: ", ethers.formatEther(wpolAfter));
  console.log("USDC: ", ethers.formatUnits(usdcAfter, 6));

  // ── PASSO 4: transferir tokens do contrato para sua wallet
  // O contrato não tem função de saque — precisamos de outro approach
  // Como você é owner E keeper, pode chamar rebalance novamente
  // MAS o contrato não tem transfer() exposto...
  
  console.log("\n⚠️  ATENÇÃO: O contrato não tem função de saque direto (transfer).");
  console.log("   Os tokens estão no contrato mas não há como extraí-los sem uma função específica.");
  console.log("   Verifique se existe 'withdrawTokens' ou similar no contrato deployado.");
  console.log("   Endereço do contrato para inspecionar no PolygonScan:");
  console.log("   https://polygonscan.com/address/0xde95b32d6B0ff10C5Bcec9e13F41aCA94D352e67#readContract");
}

main().catch(console.error);