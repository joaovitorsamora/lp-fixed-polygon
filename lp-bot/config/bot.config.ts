import { PairConfig } from "../src/analysis/data-provider";

export interface BotConfig {
  pair: string;
  pairConfig: PairConfig;

  initialLiquidityUSD: number;

  intervalMs: number;
  jitterMs: number;
  cooldownMs: number;

  minRangePct: number;
  maxRangePct: number;
  atrPeriod: number;
  atrMultiplier: number;
  deadZonePct: number;

  minDeviationPct: number;
  maxSlippageBps: number;

  maxVolatilityPct: number;
  maxPriceDropPct: number;

  feeRatePct: number;
  gasCostUSD: number;

  // Uniswap V3 tick spacing por fee tier:
  //   0.01% = 1 | 0.05% = 10 | 0.30% = 60 | 1.00% = 200
  tickSpacing: number;
}
export const DEFAULT_CONFIG: BotConfig = {
  pair: "WPOL/USDC",
  pairConfig: {
    geckoNetwork: "polygon_pos",
    geckoPoolAddress: "0xa374094527e1673a86de625aa59517c5de346d32",
    binanceSymbol: "POLUSDT",
  },

  // ⚠️ CORREÇÃO CRÍTICA
  initialLiquidityUSD: 4.5,

  // execução
  intervalMs: 30_000,
  jitterMs: 2_000,
  cooldownMs: 10 * 60_000, // 10 min (mais realista)

  // RANGE (corrigido)
 minRangePct: 0.10,  // 10%
maxRangePct: 0.25,   // 25%

  atrPeriod: 14,
  atrMultiplier: 2.2,  // mais responsivo

 deadZonePct: 0.005, // 0.5%

  // DECISÃO
  minDeviationPct: 0.02, // 2%
  maxSlippageBps: 30,

  maxVolatilityPct: 0.10,
  maxPriceDropPct: 0.07,

  feeRatePct: 0.0005,

  // ⚠️ REAL POLYGON GAS (não 0.01)
  gasCostUSD: 0.08,

  tickSpacing: 10,
};

export const PAIRS = {
  "WPOL/USDC": DEFAULT_CONFIG.pairConfig,

  "WBTC/USDC": {
    geckoNetwork:    "eth",
    geckoPoolAddress:"0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35",
    binanceSymbol:   "BTCUSDT",
  },

  "ETH/USDC-ARB": {
    geckoNetwork:    "arbitrum",
    geckoPoolAddress:"0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443",
    binanceSymbol:   "ETHUSDT",
  },

  "MATIC/USDC": {
    geckoNetwork:    "polygon",
    geckoPoolAddress:"0xA374094527e1673A86dE625aa59517c5dE346d32",
    binanceSymbol:   "MATICUSDT",
  },
} satisfies Record<string, PairConfig>;
