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
   geckoNetwork:     "polygon_pos", // Tente com underscore ou apenas "polygon"
    geckoPoolAddress: "0xa374094527e1673a86de625aa59517c5de346d32", // Tudo em minúsculo
    binanceSymbol:    "POLUSDT", 
  },

  initialLiquidityUSD: 450000,

  // Monitorização ativa: 30s é o ideal para não sobrecarregar o RPC mas reagir a tempo
  intervalMs:  30_000, 
  jitterMs:    2_000,           // Reduzi para 2s para o bot ser mais determinístico
  cooldownMs:  5 * 60_000,      // Reduzido para 5min: essencial para ranges estreitos

  // --- CONFIGURAÇÕES DE MAXIMIZAÇÃO DE TAXAS ---
  minRangePct:     0.012,       // 1.2% (Ainda mais estreito para maior multiplicador de taxas)
  maxRangePct:     0.04,        // 4% (Protege contra impermanent loss em picos de volatilidade)
  atrPeriod:       14,
  atrMultiplier:   1.2,         // Reduzi para 1.2: o range "cola" no preço atual
  deadZonePct:     0.001,       // 0.1% zona morta: aproveita micro-oscilações

  // --- EFICIÊNCIA DE EXECUÇÃO ---
  minDeviationPct: 0.01,       // Rebalanceia com 0.3% de desvio (Mantém o preço sempre no centro)
  maxSlippageBps:  30,          // 0.3% de slippage máximo para não perder lucro no swap

  maxVolatilityPct: 0.10,       // Permite operar com até 10% de vol (agressivo)
  maxPriceDropPct:  0.07,       

  feeRatePct:  0.0005,          
  gasCostUSD:  0.01,  
  
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
