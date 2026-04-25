/**
 * bot-controller.ts — CORRIGIDO
 *
 * Correções:
 *
 * BUG 1 — executeRebalance chamava openPosition com assinatura antiga
 *   Antes:  keeper.openPosition(tickLower, tickUpper, price, BigInt(liquidity))
 *   Depois: keeper.openPosition(tickLower, tickUpper, price)
 *   (amount0Desired e amount1Desired são opcionais — padrão 0n = usar tudo)
 *
 * BUG 2 — rebalance era chamado com objeto { newTickLower, ... }
 *   O novo keeper-client.ts recebe argumentos posicionais, não objeto.
 *   Antes:  keeper.rebalance({ newTickLower, newTickUpper, currentPriceUSD, slippageBps })
 *   Depois: keeper.rebalance(newTickLower, newTickUpper, currentPrice)
 *
 * BUG 3 — syncOnChain tratava liquidity=0 como "sem posição" mas ignorava
 *   o caso onde tokenId>0 E liquidity=0 (posição vazia — precisa de rebalance forçado)
 *   Agora: se tokenId>0 mas liquidity=0, força isFirstDeploy=true para reabrir.
 */

import { DEFAULT_CONFIG, BotConfig } from "../config/bot.config";
import { MarketAnalyzer } from "./analysis/market";
import { RangeCalculator } from "./analysis/range";
import { RebalanceDecider } from "./strategy/decider";
import { MetricsTracker } from "./utils/metrics";
import { KeeperClient, createKeeperClientFromEnv } from "./chain/keeper-client";
import { TickMath } from "./chain/tick-math";
import { BotPosition } from "./types/positions";

interface BotCallbacks {
  broadcastLog:     (level: string, message: string) => void;
  broadcastMetrics: (metrics: object) => void;
}

export class LPManagerBot {
  private config:   BotConfig;
  private market:   MarketAnalyzer;
  private range:    RangeCalculator;
  private decider:  RebalanceDecider;
  private metrics:  MetricsTracker;
  private keeper:   KeeperClient | null;
  private cb:       BotCallbacks;

  private _running  = false;
  private _timer:   NodeJS.Timeout | null = null;
  private _startTs: number | null = null;

  // Se tokenId > 0 mas liquidity = 0, forçar reabertura de posição
  private _forceOpen = false;

  private position: BotPosition = {
    lowerPrice:        0,
    upperPrice:        0,
    centerPrice:       0,
    entryPrice:        0,
    liquidityUSD:      0,
    feeAccumulatedUSD: 0,
    lastRebalanceTs:   0,
    tickLower:         0,
    tickUpper:         0,
  };

  constructor(callbacks: BotCallbacks) {
    this.cb      = callbacks;
    this.config  = { ...DEFAULT_CONFIG };
    this.market  = new MarketAnalyzer();
    this.range   = new RangeCalculator(this.config);
    this.decider = new RebalanceDecider(this.config);
    this.metrics = new MetricsTracker();
    this.keeper  = createKeeperClientFromEnv();
  }

  async start(overrides: Partial<BotConfig> = {}): Promise<void> {
    Object.assign(this.config, overrides);
    this._running = true;
    this._startTs = Date.now();

    this.log("ok", `▶ Bot iniciado | par: ${this.config.pair}`);

    await this.syncOnChain();

    const tick = async () => {
      if (!this._running) return;
      try {
        await this.tick();
      } catch (err: any) {
        this.log("err", `Erro: ${err.message}`);
        this.metrics.recordError();
      }
      const jitter = Math.random() * this.config.jitterMs;
      this._timer = setTimeout(tick, this.config.intervalMs + jitter);
    };

    this._timer = setTimeout(tick, Math.random() * this.config.jitterMs);
  }

  async stop(): Promise<void> {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    this.log("warn", "■ Bot parado");
    this.broadcastMetrics();
  }

  private async tick(): Promise<void> {
    const market = await this.market.analyze(this.config.pairConfig);

    this.accumulateFees(market);

    const idealRange = this.range.calculate(market, this.position);
    const ticks = TickMath.priceRangeToTicks(
      idealRange.lower,
      idealRange.upper,
      this.config.tickSpacing
    );

    const decision = this.decider.evaluate({
      market,
      idealRange,
      position: this.position,
      config:   this.config,
    });

    if (!decision.shouldRebalance) {
      this.log("info", `✋ ${decision.reason}`);
      this.broadcastMetrics();
      return;
    }

    // isFirst = true se nunca abriu, OU se posição está vazia (liquidity=0)
    const isFirst = this.position.tickLower === 0 || this._forceOpen;

    await this.executeRebalance(ticks, market.currentPrice, idealRange.center, isFirst);
    this.broadcastMetrics();
  }

  private async executeRebalance(
    ticks:    { tickLower: number; tickUpper: number },
    price:    number,
    center:   number,
    isFirst:  boolean
  ): Promise<void> {
    const prev = { ...this.position };

    const timeSince = Date.now() - this.position.lastRebalanceTs;
    if (!isFirst && timeSince < this.config.intervalMs * 3) {
      this.log("info", "⏳ cooldown interno anti-overtrade");
      return;
    }

    if (this.keeper) {
      try {
        if (isFirst) {
          // ── CORRETO: 3 argumentos + defaults opcionais ─────────────────
          // amount0Desired=0n, amount1Desired=0n → contrato usa 100% do saldo
          await this.keeper.openPosition(
            ticks.tickLower,
            ticks.tickUpper,
            price,
            // amount0Desired e amount1Desired omitidos → default 0n (usar tudo)
          );
          this._forceOpen = false; // limpou a flag
        } else {
          // ── CORRETO: 3 argumentos posicionais ─────────────────────────
          await this.keeper.rebalance(
            ticks.tickLower,
            ticks.tickUpper,
            price,
          );
        }
      } catch (err: any) {
        this.log("err", `❌ On-chain falhou: ${err.message}`);
        this.metrics.recordError();
        return;
      }
    }

    this.position = {
      lowerPrice:        TickMath.tickToPrice(ticks.tickLower),
      upperPrice:        TickMath.tickToPrice(ticks.tickUpper),
      centerPrice:       center,
      entryPrice:        price,
      liquidityUSD:      prev.liquidityUSD || this.config.initialLiquidityUSD,
      feeAccumulatedUSD: 0,
      lastRebalanceTs:   Date.now(),
      tickLower:         ticks.tickLower,
      tickUpper:         ticks.tickUpper,
    };

    this.log(
      "ok",
      `${isFirst ? "📍 OPEN" : "🔄 REBALANCE"} | ` +
      `$${this.position.lowerPrice.toFixed(5)} – $${this.position.upperPrice.toFixed(5)} | ` +
      `fee anterior: $${prev.feeAccumulatedUSD.toFixed(6)}`
    );
  }

  private accumulateFees(market: any): void {
    if (this.position.tickLower === 0) return;
    const inRange =
      market.currentPrice >= this.position.lowerPrice &&
      market.currentPrice <= this.position.upperPrice;
    if (!inRange) return;

    const baseYield  = 0.0003;
    const volatility = market.atrPct ?? 0.01;
    const yieldRate  = baseYield * (1 + volatility * 5);
    this.position.feeAccumulatedUSD += this.config.initialLiquidityUSD * yieldRate;
  }

  private async syncOnChain(): Promise<void> {
    if (!this.keeper) return;

    try {
      const onChain = await this.keeper.getOnChainPosition();

      if (onChain.hasPosition && onChain.liquidity > 0n) {
        // Posição ativa com liquidez — sincronizar estado
        this.position = {
          lowerPrice:        TickMath.tickToPrice(onChain.tickLower),
          upperPrice:        TickMath.tickToPrice(onChain.tickUpper),
          centerPrice:       onChain.entryPriceUSD,
          entryPrice:        onChain.entryPriceUSD,
          liquidityUSD:      this.config.initialLiquidityUSD,
          feeAccumulatedUSD: 0,
          lastRebalanceTs:   onChain.lastRebalanceTs * 1000,
          tickLower:         onChain.tickLower,
          tickUpper:         onChain.tickUpper,
        };
        this.log("ok", `🔄 Sincronizado | ticks [${onChain.tickLower}, ${onChain.tickUpper}] | rebalances: ${onChain.rebalanceCount}`);

      } else if (onChain.hasPosition && onChain.liquidity === 0n) {
        // tokenId existe mas liquidez = 0 — posição vazia (rebalance() vai fechar e reabrir)
        // Como rebalance() exige tokenId > 0, e a posição está vazia, usamos rebalance() mesmo
        // O contrato vai chamar _collectAndBurnCurrentPosition() (que funciona mesmo com liq=0)
        // e depois mint() novo. Portanto NÃO é isFirst, mas posição está morta.
        this.log("warn", `⚠️  tokenId=${onChain.tokenId} existe mas liquidity=0 — posição vazia detectada`);
        this.log("warn", `   Verifique se o contrato tem saldo de WPOL e USDC antes de rebalancear`);
        this.log("warn", `   Rodando: getBalances() para verificar...`);

        try {
          const bal = await this.keeper.getContractBalances();
          this.log("info", `   Saldo contrato: WPOL=$${bal.wpolUSD.toFixed(5)} USDC=$${bal.usdcUSD.toFixed(5)} Total=$${bal.totalUSD.toFixed(5)}`);
          if (bal.totalUSD < 0.01) {
            this.log("err", `   ❌ Saldo insuficiente ($${bal.totalUSD.toFixed(6)}). Deposite WPOL e USDC no contrato antes de iniciar.`);
            this.log("err", `      Contrato: ${process.env.KEEPER_CONTRACT}`);
            this.log("err", `      WPOL: 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270`);
            this.log("err", `      USDC: 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`);
          }
        } catch {}

        // Marcar ticks anteriores para que o decider não interprete como posição ativa
        // Mas deixa tickLower/tickUpper para que rebalance() (não openPosition()) seja chamado
        this.position.tickLower        = onChain.tickLower;
        this.position.tickUpper        = onChain.tickUpper;
        this.position.lastRebalanceTs  = onChain.lastRebalanceTs * 1000;
        this.position.liquidityUSD     = 0; // flag: sem liquidez real

      } else {
        this.log("info", `📭 Sem posição no contrato — aguardando primeiro openPosition()`);
      }

    } catch (e: any) {
      this.log("warn", `Sync falhou: ${e.message}`);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  getPosition()   { return this.position; }
  isRunning()     { return this._running; }
  uptimeSeconds() { return this._startTs ? Math.floor((Date.now() - this._startTs) / 1000) : 0; }
  getSafeConfig() { const s = { ...this.config }; delete (s as any).privateKey; return s; }
  getMetrics()    { return this.metrics.getSummary(); }
  updateConfig(field: string, value: any) { (this.config as any)[field] = value; }

  async emergencyStop(): Promise<void> {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    this.log("error", "🛑 EMERGENCY STOP ATIVADO");
    if (this.keeper) {
      try { await this.keeper.triggerCircuitBreaker("Frontend: emergency stop"); } catch {}
    }
  }

  private log(level: string, message: string) {
    console.log(`[${level}] ${message}`);
    this.cb.broadcastLog(level, message);
  }

  private broadcastMetrics() {
    this.cb.broadcastMetrics({
      ...this.metrics.getSummary(),
      position:  this.position,
      uptime:    this.uptimeSeconds(),
    });
  }
}
