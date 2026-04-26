// scripts/rebalance-centered.ts

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const contract = new ethers.Contract(
 process.env.KEEPER_CONTRACT!,
 [
  "function rebalance(int24,int24,uint256)",
  "function setSlippageBps(uint256)",
  "function slippageBps() view returns(uint256)"
 ],
 wallet
);

const pool = new ethers.Contract(
 "0xB6e57ed85c4c9dbfEF2a68711e9d6f36c56e0FcB",
 [
   "function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)"
 ],
 provider
);

const SPACING = 10;
const HALF_WIDTH = 300; // começar com ±3%

function priceFromTick(t:number){
 return Math.pow(1.0001,t)/1e12;
}

async function main(){

 console.log("==== REBALANCE CENTRADO ====");

 const slot0=await pool.slot0();

 const currentTick=Number(slot0[1]);

 const center=
  Math.round(currentTick/SPACING)*SPACING;

 const tickLower=center-HALF_WIDTH;
 const tickUpper=center+HALF_WIDTH;

 const price=priceFromTick(currentTick);

 console.log("Tick atual:",currentTick);
 console.log(
   "Range:",
   priceFromTick(tickLower).toFixed(5),
   "-",
   priceFromTick(tickUpper).toFixed(5)
 );

 // CORREÇÃO PRINCIPAL:
 // keeper aparentemente espera preço com 8 decimais
 const currentPrice=
   BigInt(
      Math.round(
         price*1e8
      )
   );

 console.log(
   "Preço enviado contrato:",
   currentPrice.toString()
 );

 const oldSlip=
   await contract.slippageBps();

 if(oldSlip!==0n){
   console.log("Setando slippage 0...");
   await (
     await contract.setSlippageBps(0)
   ).wait();
 }

 console.log("Estimando gas...");

 let gas;

 try{

   gas=
   await contract.rebalance.estimateGas(
      tickLower,
      tickUpper,
      currentPrice
   );

 }catch(e:any){

   console.error(
      "Revert:",
      e.shortMessage||e.message
   );

   process.exit(1);
 }

 console.log("Gas:",gas.toString());

 const tx=
 await contract.rebalance(
   tickLower,
   tickUpper,
   currentPrice,
   {
      gasLimit:gas*130n/100n
   }
 );

 console.log("TX:",tx.hash);

 await tx.wait();

 console.log("✅ Range recentralizado");

 if(oldSlip!==0n){

   console.log("Restaurando slippage...");

   await (
      await contract.setSlippageBps(
         oldSlip
      )
   ).wait();
 }

}

main().catch(console.error);