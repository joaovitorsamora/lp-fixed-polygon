export interface BotPosition {
  lowerPrice: number;
  upperPrice: number;
  centerPrice: number;
  entryPrice: number;
  liquidityUSD: number;
  feeAccumulatedUSD: number;
  lastRebalanceTs: number;
  tickLower: number;
  tickUpper: number;
}