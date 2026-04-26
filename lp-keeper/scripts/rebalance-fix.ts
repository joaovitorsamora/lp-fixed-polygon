// scripts/rebalance-fix2.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const KEEPER_CONTRACT = "0xde95b32d6B0ff10C5Bcec9e13F41aCA94D352e67";

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const contract = new ethers.Contract(KEEPER_CONTRACT, [
  "function rebalance(int24,int24,uint256) external",
  "function setSlippageBps(uint256 bps) external",
  "function slippageBps() view returns (uint256)",
  "function tokenId() view returns (uint256)",
  "function cooldownSeconds() view returns (uint256)",
  "function lastRebalanceTs() view returns (uint256)",
  "function keeperEthReserve() view returns (uint256)",
], wallet);

async function main() {
  // ── Estado atual ──────────────────────────────────────────────────────────
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

  console.log("tokenId:          ", tokenId.toString());
  console.log("slippageBps atual:", slippage.toString());
  console.log("cooldown restante:", cooldownLeft.toString(), "s");
  console.log("POL na wallet:    ", ethers.formatEther(polBal));
  console.log("keeperEthReserve: ", ethers.formatEther(keeperReserve));

  if (polBal < keeperReserve) {
    console.error("❌ POL insuficiente para o guard keeperHasGas");
    process.exit(1);
  }
  if (cooldownLeft > 0n) {
    console.error(`❌ Aguarde ${cooldownLeft}s`);
    process.exit(1);
  }

  // ── Passo 1: aumentar slippage para 500bps (5%) ───────────────────────────
  if (slippage < 500n) {
    console.log("\n⚙️  Passo 1/2 — Aumentando slippage para 500bps...");
    const txS = await contract.setSlippageBps(500, { gasLimit: 80_000 });
    console.log("TX setSlippageBps:", txS.hash);
    await txS.wait();
    console.log("✅ Slippage atualizado para 500bps (5%)");
  } else {
    console.log("✅ Slippage já ok:", slippage.toString(), "bps");
  }

  // ── Passo 2: rebalancear com ticks corretos ───────────────────────────────
  // WMATIC/USDC @ $0.09164, range ±15%
  // tickLower=250790 ($0.0778), tickUpper=253830 ($0.1055)
  // scripts/rebalance-fix2.ts — correção final

const tickLower    = 250750;
const tickUpper    = 253780;
  const currentPrice = ethers.parseUnits("0.09123", 18);
  console.log("   Range: $0.0775 – $0.1050 USDC/WMATIC");
  const gasEst = await contract.rebalance.estimateGas(tickLower, tickUpper, currentPrice);
  const feeData = await provider.getFeeData();
  const custo = gasEst * (feeData.gasPrice ?? 100_000_000_000n);
  console.log("Gas estimado:", gasEst.toString());
  console.log("Custo estimado:", ethers.formatEther(custo), "POL");

  if (polBal < custo + keeperReserve) {
    console.error("❌ POL insuficiente para cobrir gas + keeperEthReserve");
    console.error("   Precisa de:", ethers.formatEther(custo + keeperReserve), "POL");
    process.exit(1);
  }

  const tx = await contract.rebalance(tickLower, tickUpper, currentPrice, {
    gasLimit: gasEst * 120n / 100n, // +20% margem
  });

  console.log("TX rebalance:", tx.hash);
  const receipt = await tx.wait();

  if (receipt.status === 0) {
    console.error("❌ Rebalance reverteu on-chain. Veja no PolygonScan:");
    console.error(`   https://polygonscan.com/tx/${tx.hash}`);
    process.exit(1);
  }

  console.log("✅ Rebalance ok! Gas usado:", receipt.gasUsed.toString());
  console.log("\n🎉 Posição rebalanceada com sucesso!");
  console.log("   Verifique no revert.finance:");
  console.log("   https://revert.finance/#/account/0xde95b32d6b0ff10c5bcec9e13f41aca94d352e67/polygon");
}

main().catch(console.error);