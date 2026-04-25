/**
 * TickMath corrigido para Uniswap V3
 *
 * Corrige:
 * - ajuste decimal (18 vs 6)
 * - inversão opcional token orientation
 * - alinhamento de ticks
 * - describe() corrigido
 */

export interface TickRange {
  tickLower:number;
  tickUpper:number;
  priceLower:number;
  priceUpper:number;
  tickSpacing:number;
}

export class TickMath {

 static readonly MIN_TICK=-887272;
 static readonly MAX_TICK=887272;

 /*
  Para WMATIC(18)/USDC(6)
  10^(18-6)=1e12
 */
 static readonly DEFAULT_DECIMAL_ADJ=1e12;



 /*
  preço -> tick
 */
 static priceToTick(
   price:number,
   decimalAdj:number=
   TickMath.DEFAULT_DECIMAL_ADJ
 ):number{

   if(
      !Number.isFinite(price) ||
      price<=0
   ){
      throw new Error(
        "Preço inválido"
      );
   }

   return Math.floor(
      Math.log(
         price*decimalAdj
      )/
      Math.log(1.0001)
   );
 }



 /*
  tick -> preço
 */
 static tickToPrice(
   tick:number,
   decimalAdj:number=
   TickMath.DEFAULT_DECIMAL_ADJ
 ):number{

   return (
      Math.pow(
         1.0001,
         tick
      ) / decimalAdj
   );
 }



 /*
  inverter preço caso pool venha invertido
 */
 static invertPrice(
   price:number
 ){
   return 1/price;
 }



 static alignTick(
   tick:number,
   tickSpacing:number,
   direction:"floor"|"ceil"
 ):number{

   if(direction==="floor"){
      return (
         Math.floor(
           tick/tickSpacing
         )*tickSpacing
      );
   }

   return (
      Math.ceil(
        tick/tickSpacing
      )*tickSpacing
   );
 }



 static clampTick(
   tick:number,
   tickSpacing:number
 ):number{

   const minAligned=
   Math.ceil(
      this.MIN_TICK/tickSpacing
   )*tickSpacing;

   const maxAligned=
   Math.floor(
      this.MAX_TICK/tickSpacing
   )*tickSpacing;

   return Math.max(
      minAligned,
      Math.min(
        maxAligned,
        tick
      )
   );
 }



 static priceRangeToTicks(
   lowerPriceUSD:number,
   upperPriceUSD:number,
   tickSpacing=10,
   decimalAdj:number=
   TickMath.DEFAULT_DECIMAL_ADJ
 ):TickRange{

   if(
      lowerPriceUSD>=upperPriceUSD
   ){
      throw new Error(
       `Range inválido`
      );
   }


   const rawTickLower=
   this.priceToTick(
      lowerPriceUSD,
      decimalAdj
   );

   const rawTickUpper=
   this.priceToTick(
      upperPriceUSD,
      decimalAdj
   );


   const tickLower=
   this.clampTick(
      this.alignTick(
         rawTickLower,
         tickSpacing,
         "floor"
      ),
      tickSpacing
   );


   const tickUpper=
   this.clampTick(
      this.alignTick(
         rawTickUpper,
         tickSpacing,
         "ceil"
      ),
      tickSpacing
   );


   if(
      tickLower>=tickUpper
   ){
      throw new Error(
       "Ticks colapsaram"
      );
   }


   return {
      tickLower,
      tickUpper,

      priceLower:
      this.tickToPrice(
         tickLower,
         decimalAdj
      ),

      priceUpper:
      this.tickToPrice(
         tickUpper,
         decimalAdj
      ),

      tickSpacing
   };
 }



 static isPriceInRange(
   price:number,
   tickLower:number,
   tickUpper:number,
   decimalAdj:number=
   TickMath.DEFAULT_DECIMAL_ADJ
 ):boolean{

   const tick=
   this.priceToTick(
      price,
      decimalAdj
   );

   return (
      tick>=tickLower &&
      tick<tickUpper
   );
 }



 static pricePositionInRange(
   currentPrice:number,
   tickLower:number,
   tickUpper:number,
   decimalAdj:number=
   TickMath.DEFAULT_DECIMAL_ADJ
 ):number{

   const currentTick=
   this.priceToTick(
      currentPrice,
      decimalAdj
   );

   if(currentTick<=tickLower){
      return 0;
   }

   if(currentTick>=tickUpper){
      return 1;
   }

   return (
      currentTick-tickLower
   )/
   (
      tickUpper-tickLower
   );
 }



 static describe(
   tickLower:number,
   tickUpper:number,
   decimalAdj:number=
   TickMath.DEFAULT_DECIMAL_ADJ
 ):string{

   const lower=
   this.tickToPrice(
      tickLower,
      decimalAdj
   );

   const upper=
   this.tickToPrice(
      tickUpper,
      decimalAdj
   );

   const widthPct=
   (
    (upper/lower)-1
   )*100;

   return (
    `[$${lower.toFixed(5)} — `+
    `$${upper.toFixed(5)}] `+
    `(largura ${widthPct.toFixed(2)}%)`
   );
 }

}