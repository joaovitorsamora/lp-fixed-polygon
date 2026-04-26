// scripts/diagnose-nft.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const NPM      = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const POOL_B6  = "0xB6e57ed85c4c9dbfEF2a68711e9d6f36c56e0FcB";
const FACTORY  = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const KEEPER   = "0xde95b32d6B0ff10C5Bcec9e13F41aCA94D352e67";
const TOKEN_ID = 2894212;

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);

const npm = new ethers.Contract(NPM, [
  "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
  "function ownerOf(uint256) view returns (address)",
], provider);

const pool = new ethers.Contract(POOL_B6, [
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
], provider);

const factory = new ethers.Contract(FACTORY, [
  "function getPool(address,address,uint24) view returns (address)",
], provider);

const keeper = new ethers.Contract(KEEPER, [
  "function tokenId() view returns (uint256)",
  "function tickLower() view returns (int24)",
  "function tickUpper() view returns (int24)",
], provider);

async function main() {
  console.log("=== NFT", TOKEN_ID, "no NPM ===");
  const pos = await npm.positions(TOKEN_ID);
  const token0 = pos[2];
  const token1 = pos[3];
  const fee    = pos[4];
  const tL     = Number(pos[5]);
  const tU     = Number(pos[6]);
  const liq    = pos[7];
  console.log("token0:", token0);
  console.log("token1:", token1);
  console.log("fee:   ", fee.toString());
  console.log("tickLower:", tL);
  console.log("tickUpper:", tU);
  console.log("liquidity:", liq.toString());
  console.log("owner:", await npm.ownerOf(TOKEN_ID));

  console.log("\n=== Pool 0xb6e57e ===");
  const t0   = await pool.token0();
  const t1   = await pool.token1();
  const feeP = await pool.fee();
  const s0   = await pool.slot0();
  console.log("token0:", t0);
  console.log("token1:", t1);
  console.log("fee:   ", feeP.toString());
  console.log("currentTick:", Number(s0[1]));

  console.log("\n=== Factory: pool para WPOL/USDC/500 ===");
  const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
  const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
  const poolAddr = await factory.getPool(WPOL, USDC, 500);
  console.log("pool WPOL/USDC/500:", poolAddr);
  console.log("é o 0xb6e57e?", poolAddr.toLowerCase() === POOL_B6.toLowerCase() ? "✅ SIM" : "❌ NÃO — são pools diferentes!");

  console.log("\n=== Contrato Keeper ===");
  const kTokenId = await keeper.tokenId();
  const kTL      = await keeper.tickLower();
  const kTU      = await keeper.tickUpper();
  console.log("tokenId armazenado:", kTokenId.toString());
  console.log("tickLower armazenado:", Number(kTL));
  console.log("tickUpper armazenado:", Number(kTU));
}

main().catch(console.error);