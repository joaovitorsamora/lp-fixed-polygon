/**
 * keeper-client.ts — CORRIGIDO
 *
 * Correções aplicadas:
 *
 * BUG 1 — getPosition() não existe no contrato deployado
 *   O contrato só tem variáveis públicas individuais (tokenId, tickLower, tickUpper, etc.)
 *   mas NÃO tem uma função getPosition().
 *   CORREÇÃO: syncOnChain() agora lê as variáveis públicas separadas via
 *   leituras paralelas, sem chamar nenhuma função inexistente.
 *
 * BUG 2 — ABI de openPosition estava ERRADO
 *   ABI antigo:     openPosition(int24, int24, uint256, uint128)  ← 4 args
 *   Contrato real:  openPosition(int24, int24, uint256, uint256, uint256)  ← 5 args
 *   (tickLower, tickUpper, amount0Desired, amount1Desired, currentPrice)
 *   CORREÇÃO: ABI e método openPosition() corrigidos para 5 argumentos.
 *
 * BUG 3 — bot-controller.ts chamava openPosition() com liquidityRaw = BigInt(0)
 *   Isso passava amount0Desired=0 E amount1Desired=0, fazendo o contrato
 *   tentar mint com zero tokens → revert inevitável.
 *   CORREÇÃO: openPosition() agora passa amount0Desired=0n, amount1Desired=0n
 *   intencionalmente — o contrato usa `bal0` e `bal1` quando desired=0.
 *   Isso é o comportamento correto ("use tudo disponível").
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy, hardhat, arbitrum, arbitrumSepolia } from "viem/chains";
import { Logger } from "../utils/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Endereços Polygon Mainnet
// ─────────────────────────────────────────────────────────────────────────────

export const POLYGON_ADDRESSES = {
  WPOL:               "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270" as Address,
  USDC:               "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as Address,
  NPM:                "0xC36442b4a4522E871399CD717aBDD847Ab11FE88" as Address,
  POOL_WPOL_USDC_005: "0xa374094527e1673a86de625aa59517c5de346d32" as Address,
};

// ─────────────────────────────────────────────────────────────────────────────
// ABI — exatamente igual ao contrato deployado
// ─────────────────────────────────────────────────────────────────────────────

const KEEPER_ABI = [
  // ── Views (variáveis públicas do contrato) ───────────────────────────────
  {
    name: "tokenId",
    type: "function", stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "tickLower",
    type: "function", stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "int24" }],
  },
  {
    name: "tickUpper",
    type: "function", stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "int24" }],
  },
  {
    name: "posLiquidity",
    type: "function", stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    name: "entryPriceRaw",
    type: "function", stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "feeAccumulated0",
    type: "function", stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "feeAccumulated1",
    type: "function", stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "lastRebalanceTs",
    type: "function", stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "rebalanceCount",
    type: "function", stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "paused",
    type: "function", stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "cooldownSeconds",
    type: "function", stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },

  // ── canRebalance (função view que agrega os checks) ───────────────────────
  {
    name: "canRebalance",
    type: "function", stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "ok",     type: "bool"   },
      { name: "reason", type: "string" },
    ],
  },

  // ── getBalances ───────────────────────────────────────────────────────────
  {
    name: "getBalances",
    type: "function", stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "wpolBal", type: "uint256" },
      { name: "usdcBal", type: "uint256" },
    ],
  },

  // ── WRITE: openPosition — 5 argumentos (assinatura real do contrato) ─────
  //
  // function openPosition(
  //   int24   _tickLower,
  //   int24   _tickUpper,
  //   uint256 amount0Desired,   ← WPOL desejado (0 = usar tudo disponível)
  //   uint256 amount1Desired,   ← USDC desejado (0 = usar tudo disponível)
  //   uint256 currentPrice      ← preço * 1e18 para tracking
  // )
  {
    name: "openPosition",
    type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "_tickLower",     type: "int24"   },
      { name: "_tickUpper",     type: "int24"   },
      { name: "amount0Desired", type: "uint256" },
      { name: "amount1Desired", type: "uint256" },
      { name: "currentPrice",   type: "uint256" },
    ],
    outputs: [],
  },

  // ── WRITE: rebalance — 3 argumentos ─────────────────────────────────────
  {
    name: "rebalance",
    type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "newTickLower", type: "int24"   },
      { name: "newTickUpper", type: "int24"   },
      { name: "currentPrice", type: "uint256" },
    ],
    outputs: [],
  },

  // ── WRITE: outros ─────────────────────────────────────────────────────────
  {
    name: "harvest",
    type: "function", stateMutability: "nonpayable",
    inputs: [], outputs: [],
  },
  {
    name: "triggerCircuitBreaker",
    type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "reason", type: "string" }], outputs: [],
  },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

export interface OnChainPosition {
  tickLower:       number;
  tickUpper:       number;
  liquidity:       bigint;
  entryPriceUSD:   number;
  feeAccum0Raw:    bigint;
  feeAccum1Raw:    bigint;
  feeAccum0USD:    number;
  feeAccum1USD:    number;
  lastRebalanceTs: number;
  rebalanceCount:  number;
  tokenId:         bigint;
  hasPosition:     boolean;
}

export interface ContractBalances {
  wpolRaw:  bigint;
  usdcRaw:  bigint;
  wpolUSD:  number;
  usdcUSD:  number;
  totalUSD: number;
}

export interface KeeperConfig {
  rpcUrl:          string;
  privateKey:      `0x${string}`;
  contractAddress: Address;
  chainId:         number;
  dryRun:          boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// KeeperClient
// ─────────────────────────────────────────────────────────────────────────────

export class KeeperClient {
  private pub:    PublicClient;
  private wallet: WalletClient;
  private addr:   Address;
  private dryRun: boolean;
  private log = new Logger("KeeperClient");

  constructor(cfg: KeeperConfig) {
    this.addr   = cfg.contractAddress;
    this.dryRun = cfg.dryRun;

    const chain =
      cfg.chainId === 137    ? polygon        :
      cfg.chainId === 80002  ? polygonAmoy    :
      cfg.chainId === 42161  ? arbitrum       :
      cfg.chainId === 421614 ? arbitrumSepolia:
      hardhat;

    const transport = http(cfg.rpcUrl);
    this.pub    = createPublicClient({ chain, transport });
    this.wallet = createWalletClient({
      account: privateKeyToAccount(cfg.privateKey),
      chain, transport,
    });

    this.log.info(`chain: ${chain.name} | dryRun: ${cfg.dryRun} | contract: ${cfg.contractAddress}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // getOnChainPosition — lê variáveis públicas individualmente
  // NÃO chama getPosition() (função que não existe no contrato atual)
  // ─────────────────────────────────────────────────────────────────────────

  async getOnChainPosition(polPriceUSD = 0.094): Promise<OnChainPosition> {
    // Leituras paralelas das variáveis públicas do contrato
    const read = (name: string) =>
      this.pub.readContract({
        address:      this.addr,
        abi:          KEEPER_ABI,
        functionName: name as any,
      });

    const [tid, tLower, tUpper, liq, entryPrice, fee0, fee1, lastTs, rebCount] =
      await Promise.all([
        read("tokenId"),
        read("tickLower"),
        read("tickUpper"),
        read("posLiquidity"),
        read("entryPriceRaw"),
        read("feeAccumulated0"),
        read("feeAccumulated1"),
        read("lastRebalanceTs"),
        read("rebalanceCount"),
      ]) as [bigint, number, number, bigint, bigint, bigint, bigint, bigint, bigint];

    return {
      tickLower:       Number(tLower),
      tickUpper:       Number(tUpper),
      liquidity:       liq,
      entryPriceUSD:   parseFloat(formatUnits(entryPrice, 18)),
      feeAccum0Raw:    fee0,
      feeAccum1Raw:    fee1,
      feeAccum0USD:    parseFloat(formatUnits(fee0, 18)) * polPriceUSD,
      feeAccum1USD:    parseFloat(formatUnits(fee1, 6)),  // USDC direto em USD
      lastRebalanceTs: Number(lastTs),
      rebalanceCount:  Number(rebCount),
      tokenId:         tid,
      hasPosition:     tid > 0n,
    };
  }

  // ── canRebalance ──────────────────────────────────────────────────────────

  async canRebalance(): Promise<{ ok: boolean; reason: string }> {
    const [ok, reason] = await this.pub.readContract({
      address:      this.addr,
      abi:          KEEPER_ABI,
      functionName: "canRebalance",
    }) as [boolean, string];
    return { ok, reason };
  }

  // ── getContractBalances ───────────────────────────────────────────────────

  async getContractBalances(polPriceUSD = 0.094): Promise<ContractBalances> {
    const [wpolRaw, usdcRaw] = await this.pub.readContract({
      address:      this.addr,
      abi:          KEEPER_ABI,
      functionName: "getBalances",
    }) as [bigint, bigint];

    const wpolUSD = parseFloat(formatUnits(wpolRaw, 18)) * polPriceUSD;
    const usdcUSD = parseFloat(formatUnits(usdcRaw, 6));
    return { wpolRaw, usdcRaw, wpolUSD, usdcUSD, totalUSD: wpolUSD + usdcUSD };
  }

  async isPaused(): Promise<boolean> {
    return this.pub.readContract({
      address:      this.addr,
      abi:          KEEPER_ABI,
      functionName: "paused",
    }) as Promise<boolean>;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // openPosition — 5 argumentos (igual ao contrato)
  //
  // Passa amount0Desired=0n e amount1Desired=0n para dizer ao contrato
  // "use TUDO que você tiver de WPOL e USDC" — é o comportamento correto
  // para capital pequeno onde você quer usar 100% do saldo.
  // ─────────────────────────────────────────────────────────────────────────

  async openPosition(
    tickLower:     number,
    tickUpper:     number,
    currentPrice:  number,
    // amount0Desired e amount1Desired opcionais: 0n = usar tudo disponível
    amount0Desired = 0n,
    amount1Desired = 0n,
  ): Promise<Hash | null> {
    const priceRaw = parseUnits(currentPrice.toFixed(18), 18);

    this.log.info(
      `${this.dryRun ? "[DRY] " : ""}openPosition | ` +
      `ticks [${tickLower}, ${tickUpper}] | ` +
      `preço $${currentPrice.toFixed(6)} | ` +
      `amount0: ${amount0Desired === 0n ? "tudo disponível" : amount0Desired.toString()} | ` +
      `amount1: ${amount1Desired === 0n ? "tudo disponível" : amount1Desired.toString()}`
    );

    return this._write("openPosition", [
      tickLower,
      tickUpper,
      amount0Desired,
      amount1Desired,
      priceRaw,
    ]);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // rebalance — 3 argumentos (igual ao contrato)
  // ─────────────────────────────────────────────────────────────────────────

  async rebalance(
    newTickLower:  number,
    newTickUpper:  number,
    currentPrice:  number,
  ): Promise<Hash | null> {
    const priceRaw = parseUnits(currentPrice.toFixed(18), 18);

    this.log.info(
      `${this.dryRun ? "[DRY] " : ""}rebalance | ` +
      `ticks [${newTickLower}, ${newTickUpper}] | ` +
      `preço $${currentPrice.toFixed(6)}`
    );

    return this._write("rebalance", [newTickLower, newTickUpper, priceRaw]);
  }

  async harvest(): Promise<Hash | null> {
    this.log.info(`${this.dryRun ? "[DRY] " : ""}harvest`);
    return this._write("harvest", []);
  }

  async triggerCircuitBreaker(reason: string): Promise<Hash | null> {
    this.log.warn(`circuit breaker: ${reason}`);
    return this._write("triggerCircuitBreaker", [reason]);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal
  // ─────────────────────────────────────────────────────────────────────────

  private async _write(funcName: string, args: unknown[]): Promise<Hash | null> {
    if (this.dryRun) {
      try {
        await this.pub.simulateContract({
          address:      this.addr,
          abi:          KEEPER_ABI,
          functionName: funcName as any,
          args:         args as any,
          account:      this.wallet.account,
        });
        this.log.info(`[DRY] ${funcName} simulado OK`);
      } catch (e: any) {
        this.log.error(`[DRY] ${funcName} simulação falhou: ${e.message}`);
        throw e;
      }
      return null;
    }

    const { request } = await this.pub.simulateContract({
      address:      this.addr,
      abi:          KEEPER_ABI,
      functionName: funcName as any,
      args:         args as any,
      account:      this.wallet.account,
    });

    const hash = await this.wallet.writeContract(request);
    this.log.info(`${funcName} tx: ${hash}`);
    const receipt = await this.pub.waitForTransactionReceipt({ hash });
    this.log.info(`${funcName} confirmado | bloco: ${receipt.blockNumber} | gas: ${receipt.gasUsed}`);
    return hash;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createKeeperClientFromEnv(): KeeperClient | null {
  const rpcUrl   = process.env.RPC_URL;
  const pk       = process.env.PRIVATE_KEY;
  const contract = process.env.KEEPER_CONTRACT;
  const chainId  = parseInt(process.env.CHAIN_ID ?? "137");
  const dryRun   = process.env.DRY_RUN !== "false";

  if (!rpcUrl || !pk || !contract ||
      contract === "0x0000000000000000000000000000000000000000") {
    return null;
  }

  return new KeeperClient({
    rpcUrl,
    privateKey:      pk as `0x${string}`,
    contractAddress: contract as Address,
    chainId,
    dryRun,
  });
}
