import { BotConfig } from "../../config/bot.config";
import { MarketData } from "../analysis/market";
import { RangeCalculator, RangeResult } from "../analysis/range";
import { BotPosition } from "../types/positions";

export interface DecisionInput {
  market: MarketData;
  idealRange: RangeResult;
  position: BotPosition;
  config: BotConfig;
}

export interface Decision {
  shouldRebalance: boolean;
  reason: string;
  checks: {
    priceOutOfRange: boolean;
    deviationSufficient: boolean;
    cooldownPassed: boolean;
    economicallyJustified: boolean;
  };
  estimatedIL: number;
  estimatedFeeIfStay: number;
}

export class RebalanceDecider {
  constructor(private config: BotConfig) {}

  evaluate(input: DecisionInput): Decision {
    const { market, position, config } = input;

    if (position.lowerPrice === 0) {
      return this.approve("Posição inicial — primeiro deploy", input);
    }

    const rangeCheck = RangeCalculator.isPriceOutOfRange(
      market.currentPrice,
      position.lowerPrice,
      position.upperPrice,
      config.deadZonePct
    );

    if (!rangeCheck.isOut) {
      return this.deny("Preço dentro do range (dead zone)", {
        priceOutOfRange: false,
        deviationSufficient: false,
        cooldownPassed: false,
        economicallyJustified: false,
      }, input);
    }

    const deviationOk =
  rangeCheck.deviationPct >= Math.max(
    config.minDeviationPct,
    0.003 // piso absoluto 0.3%
  );

    if (!deviationOk) {
      return this.deny("Desvio insuficiente", {
        priceOutOfRange: true,
        deviationSufficient: false,
        cooldownPassed: false,
        economicallyJustified: false,
      }, input);
    }

    const elapsed = Date.now() - position.lastRebalanceTs;
    const cooldownOk = elapsed >= config.cooldownMs;

    if (!cooldownOk) {
      return this.deny("Cooldown ativo", {
        priceOutOfRange: true,
        deviationSufficient: true,
        cooldownPassed: false,
        economicallyJustified: false,
      }, input);
    }

    const il = this.estimateIL(
      market.currentPrice,
      position.entryPrice,
      position.liquidityUSD
    );

    const feeIfStay = this.estimateFeeIfStay(position, config);

 const gasPenalty = config.gasCostUSD * 0.3;

// IL relevante OU movimento forte
const economicOk =
  il > gasPenalty ||
  rangeCheck.deviationPct > 0.015;

    if (!economicOk) {
      return this.deny("Não vale economicamente", {
        priceOutOfRange: true,
        deviationSufficient: true,
        cooldownPassed: true,
        economicallyJustified: false,
      }, input, il, feeIfStay);
    }

    return {
      shouldRebalance: true,
      reason: "✅ Rebalance aprovado",
      checks: {
        priceOutOfRange: true,
        deviationSufficient: true,
        cooldownPassed: true,
        economicallyJustified: true,
      },
      estimatedIL: il,
      estimatedFeeIfStay: feeIfStay,
    };
  }

  private estimateIL(current: number, entry: number, liq: number): number {
    if (!entry || !liq) return 0;
    const k = current / entry;
    const il = (2 * Math.sqrt(k)) / (1 + k) - 1;
    return Math.abs(il) * liq;
  }

  private estimateFeeIfStay(position: BotPosition, config: BotConfig): number {
    const feePerHour = position.liquidityUSD * config.feeRatePct;
    return feePerHour * 2;
  }

  private approve(reason: string, input: DecisionInput): Decision {
    return {
      shouldRebalance: true,
      reason,
      checks: {
        priceOutOfRange: true,
        deviationSufficient: true,
        cooldownPassed: true,
        economicallyJustified: true,
      },
      estimatedIL: 0,
      estimatedFeeIfStay: 0,
    };
  }

  private deny(
    reason: string,
    checks: Decision["checks"],
    input: DecisionInput,
    il = 0,
    fee = 0
  ): Decision {
    return {
      shouldRebalance: false,
      reason,
      checks,
      estimatedIL: il,
      estimatedFeeIfStay: fee,
    };
  }
}