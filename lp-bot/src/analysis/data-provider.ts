/**
 * DataProvider — Camada de abstração para fontes de dados de mercado
 */

import { ethers, getAddress } from "ethers";
import { MockDataProvider, MockScenario } from "./mock-provider";

export interface OHLCV {
 timestamp:number;
 open:number;
 high:number;
 low:number;
 close:number;
 volume:number;
}

export interface PoolData {
 price:number;
 priceChange24h:number;
 volume24h:number;
 liquidity:number;
 feeTier:number;
 token0Symbol:string;
 token1Symbol:string;
}

export interface PairConfig {
 geckoNetwork:string;
 geckoPoolAddress:string;
 binanceSymbol:string;
}

const UNIV3_POOL_ABI=[
"function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
"function liquidity() view returns(uint128)",
"function token0() view returns(address)",
"function token1() view returns(address)"
];

const ERC20_ABI=[
"function decimals() view returns(uint8)",
"function symbol() view returns(string)"
];

export class OnChainProvider {
 private provider:ethers.JsonRpcProvider;

 constructor(rpcUrl:string){
   this.provider=new ethers.JsonRpcProvider(rpcUrl);
 }

 async fetchCurrentPoolData(
   poolAddress:string
 ):Promise<{price:number; liquidity:string}> {

   const safeAddress=getAddress(poolAddress);

   const contract=
   new ethers.Contract(
      safeAddress,
      UNIV3_POOL_ABI,
      this.provider
   );

   const [slot,liq,token0Addr,token1Addr]=await Promise.all([
      contract.slot0(),
      contract.liquidity(),
      contract.token0(),
      contract.token1()
   ]);

   const token0=
   new ethers.Contract(
      token0Addr,
      ERC20_ABI,
      this.provider
   );

   const token1=
   new ethers.Contract(
      token1Addr,
      ERC20_ABI,
      this.provider
   );

   const [dec0,dec1]=await Promise.all([
      token0.decimals(),
      token1.decimals()
   ]);

   const sqrtPriceX96=
   BigInt(slot.sqrtPriceX96);

   const rawPrice=
   (Number(sqrtPriceX96)/Math.pow(2,96))**2;

   const decimalAdj=
   Math.pow(
      10,
      Number(dec0)-Number(dec1)
   );

   let price=rawPrice*decimalAdj;

   const usdc=
   process.env.USDC_ADDRESS?.toLowerCase();

   if(
      usdc &&
      token0Addr.toLowerCase()===usdc
   ){
      price=1/price;
   }

   if(
      !Number.isFinite(price) ||
      price<=0
   ){
      throw new Error(
       "Preço inválido calculado do slot0"
      );
   }

   return {
      price,
      liquidity: liq.toString()
   };
 }
}

export class GeckoTerminalProvider {
 private readonly base=
 "https://api.geckoterminal.com/api/v2";

 async fetchOHLCV(
  network:string,
  poolAddress:string,
  limit=50,
  timeframe:"day"|"hour"|"minute"="hour"
 ):Promise<OHLCV[]> {

 const url=
 `${this.base}/networks/${network}/pools/${poolAddress}/ohlcv/${timeframe}?limit=${limit}&token=base`;

 const res=await fetch(url,{headers:{
  Accept:"application/json",
  "User-Agent":"lp-manager-bot/2.0"
 }});

 if(!res.ok){
  throw new Error(
   `GeckoTerminal OHLCV ${res.status}`
  );
 }

 const data=await res.json() as {
 data:{attributes:{
 ohlcv_list:[number,number,number,number,number,number][]
 }}
 };

 return data.data.attributes.ohlcv_list.map(
 ([ts,o,h,l,c,v])=>(
 {
 timestamp:ts*1000,
 open:o,
 high:h,
 low:l,
 close:c,
 volume:v
 })
 );
 }

 async fetchPoolData(
  network:string,
  poolAddress:string
 ):Promise<PoolData>{

 const url=
 `${this.base}/networks/${network}/pools/${poolAddress}`;

 const res=await fetch(url,{headers:{
 Accept:"application/json"
 }});

 if(!res.ok){
 throw new Error(
 `GeckoTerminal pool ${res.status}`
 );
 }

 const data=await res.json() as {
 data:{attributes:{
 base_token_price_usd:string;
 price_change_percentage:{h24:string};
 volume_usd:{h24:string};
 reserve_in_usd:string;
 pool_fee:string;
 name:string;
 }}
 };

 const a=data.data.attributes;

 return {
 price:parseFloat(a.base_token_price_usd),
 priceChange24h:
 parseFloat(a.price_change_percentage.h24)/100,
 volume24h:
 parseFloat(a.volume_usd.h24),
 liquidity:
 parseFloat(a.reserve_in_usd),
 feeTier:
 parseFloat(a.pool_fee||"0.3")/100,
 token0Symbol:
 a.name.split(" / ")[0]??"TOKEN0",
 token1Symbol:
 a.name.split(" / ")[1]?.split(" ")[0]??"TOKEN1"
 };
 }
}

export class BinanceProvider {
 private readonly base=
 "https://api.binance.com/api/v3";

 async fetchOHLCV(
 symbol:string,
 interval="1h",
 limit=50
 ):Promise<OHLCV[]>{

 const url=
 `${this.base}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;

 const res=await fetch(url);

 if(!res.ok){
 throw new Error(
 `Binance klines ${res.status}`
 );
 }

 const raw=await res.json() as
 [number,string,string,string,string,string][];

 return raw.map(
 ([ts,o,h,l,c,v])=>({
 timestamp:ts,
 open:parseFloat(o),
 high:parseFloat(h),
 low:parseFloat(l),
 close:parseFloat(c),
 volume:parseFloat(v)
 })
 );
 }

 async fetch24hStats(symbol:string){
 const url=
 `${this.base}/ticker/24hr?symbol=${symbol}`;

 const res=await fetch(url);
 if(!res.ok){
 throw new Error(
 `Binance 24hr ${res.status}`
 );
 }

 const d=await res.json() as {
 lastPrice:string;
 priceChangePercent:string;
 volume:string;
 };

 return {
 price:parseFloat(d.lastPrice),
 change24h:
 parseFloat(d.priceChangePercent)/100,
 volume:
 parseFloat(d.volume)
 };
 }
}

export class DataFetcher {
 protected gecko=new GeckoTerminalProvider();
 protected binance=new BinanceProvider();

 protected onChain=
 new OnChainProvider(
 process.env.RPC_URL||
 "https://polygon-rpc.com"
 );

 private cache:{
 ohlcv:OHLCV[];
 poolData:Partial<PoolData>;
 fetchedAt:number;
 source:string;
 }|null=null;

 private readonly CACHE_TTL_MS=
 5*60_000;

 async fetchOHLCV(pair:PairConfig){
 try{
 const candles=
 await this.gecko.fetchOHLCV(
 pair.geckoNetwork,
 pair.geckoPoolAddress,
 50
 );

 this.updateCache(candles,{});

 return {
 candles,
 source:"GeckoTerminal"
 };
 }catch(e){
 console.warn(
 `[DataFetcher] Gecko falhou ${(e as Error).message}`
 );
 }

 try{
 const candles=
 await this.binance.fetchOHLCV(
 pair.binanceSymbol,
 "1h",
 50
 );

 return {
 candles,
 source:"Binance"
 };
 }catch(e){
 console.warn(
 `[DataFetcher] Binance falhou ${(e as Error).message}`
 );
 }

 if(
 this.cache &&
 Date.now()-this.cache.fetchedAt<
 this.CACHE_TTL_MS
 ){
 return {
 candles:this.cache.ohlcv,
 source:"cache"
 };
 }

 throw new Error(
 "Todas as fontes falharam"
 );
 }

 async fetchPoolData(pair:PairConfig){
 try{
 const data=
 await this.onChain.fetchCurrentPoolData(
 getAddress(pair.geckoPoolAddress)
 );

 let stats={
 change24h:0,
 volume:0
 };

 try{
 stats=
 await this.binance.fetch24hStats(
 pair.binanceSymbol
 );
 }catch{}

 return {
 price:data.price,
 liquidity:
 parseFloat(data.liquidity),
 priceChange24h:
 stats.change24h,
 volume24h:
 stats.volume,
 source:"On-Chain"
 };
 }catch(e){
 console.warn(
 `[DataFetcher] onchain falhou ${(e as Error).message}`
 );
 }

 try{
 const pool=
 await this.gecko.fetchPoolData(
 pair.geckoNetwork,
 pair.geckoPoolAddress
 );

 return {
 ...pool,
 source:"GeckoTerminal"
 };
 }catch{}

 const s=
 await this.binance.fetch24hStats(
 pair.binanceSymbol
 );

 return {
 price:s.price,
 priceChange24h:s.change24h,
 volume24h:s.volume,
 source:"Binance"
 };
 }

 private updateCache(
 ohlcv:OHLCV[],
 poolData:Partial<PoolData>
 ){
 this.cache={
 ohlcv,
 poolData,
 fetchedAt:Date.now(),
 source:"gecko"
 };
 }

 static closePrices(
 candles:OHLCV[]
 ){
 return candles.map(c=>c.close);
 }
}

export class DataFetcherWithMock
extends DataFetcher{

 private mock:
 MockDataProvider|null=null;

 constructor(){
 super();

 if(
 process.env.USE_MOCK==="true"
 ){
 const scenario=
 (process.env.MOCK_SCENARIO??
 "sideways") as MockScenario;

 this.mock=
 new MockDataProvider(
 scenario,
 0.60
 );
 }
 }

 async fetchOHLCV(pair:PairConfig){
 if(this.mock){
 return {
 candles:
 this.mock.generateOHLCV(50),
 source:
 `mock:${process.env.MOCK_SCENARIO}`
 };
 }

 return super.fetchOHLCV(pair);
 }

 async fetchPoolData(pair:PairConfig){
 if(this.mock){
 const candles=
 this.mock.generateOHLCV(1);

 return {
 price:candles[0].close,
 liquidity:2000000,
 priceChange24h:0,
 volume24h:3000000,
 source:"mock"
 };
 }

 return super.fetchPoolData(pair);
 }
}