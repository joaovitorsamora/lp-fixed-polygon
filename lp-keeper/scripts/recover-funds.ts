import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const RPC_URL = process.env.RPC_URL!;
const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const POSITION_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const TOKEN_ID = 2894165;

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const pm = new ethers.Contract(
  POSITION_MANAGER,
  [
    "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
    "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline))",
    "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max))",
    "function burn(uint256 tokenId)"
  ],
  wallet
);

const MaxUint128 = (1n << 128n) - 1n;

async function main() {
  console.log("🔎 Lendo posição...");

  const pos = await pm.positions(TOKEN_ID);
  const liquidity = pos[7];

  console.log("💧 Liquidez:", liquidity.toString());

  if (liquidity > 0n) {
    console.log("📉 Removendo liquidez total...");

    const tx1 = await pm.decreaseLiquidity({
      tokenId: TOKEN_ID,
      liquidity,
      amount0Min: 0,
      amount1Min: 0,
      deadline: Math.floor(Date.now() / 1000) + 600
    });

    await tx1.wait();
  }

  console.log("💰 Coletando tokens...");

  const tx2 = await pm.collect({
    tokenId: TOKEN_ID,
    recipient: wallet.address,
    amount0Max: MaxUint128,
    amount1Max: MaxUint128
  });

  await tx2.wait();

  console.log("🔥 Queimando NFT...");

  const tx3 = await pm.burn(TOKEN_ID);
  await tx3.wait();

  console.log("✅ FUNDO TOTAL RECUPERADO NA WALLET");
}

main().catch(console.error);