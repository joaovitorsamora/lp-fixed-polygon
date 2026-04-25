/**
 * server.ts — versão corrigida e estável
 */

import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "../.env") });

import { LPManagerBot } from "./bot-controller";

// ─────────────────────────────────────────────
// SSE
// ─────────────────────────────────────────────

type SSEClient = Response;

const sseClients = new Set<SSEClient>();

export function broadcastLog(level: string, message: string): void {
  const payload = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
  });

  const data = `data: ${payload}\n\n`;

  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

export function broadcastMetrics(metrics: object): void {
  const payload = JSON.stringify({ type: "metrics", ...metrics });

  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ─────────────────────────────────────────────
// APP
// ─────────────────────────────────────────────

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── BOT ───────────────────────────────────────

const bot = new LPManagerBot({
  broadcastLog,
  broadcastMetrics,
});

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

app.get("/api/status", (_req: Request, res: Response) => {
  res.json({
    running: bot.isRunning(),
    uptime: bot.uptimeSeconds(),
    config: bot.getSafeConfig(),
    position: bot.getPosition(),
    chainId: process.env.CHAIN_ID ?? "137",
    dryRun: process.env.DRY_RUN !== "false",
    contract: process.env.KEEPER_CONTRACT ?? "",
    rpcUrl: process.env.RPC_URL ?? "",
  });
});

app.get("/api/metrics", (_req: Request, res: Response) => {
  res.json(bot.getMetrics());
});

app.post("/api/start", async (req: Request, res: Response) => {
  if (bot.isRunning()) {
    return res.status(409).json({ error: "Bot já está rodando" });
  }

  try {
    await bot.start(req.body ?? {});
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/stop", async (_req: Request, res: Response) => {
  if (!bot.isRunning()) {
    return res.status(409).json({ error: "Bot não está rodando" });
  }

  await bot.stop();
  return res.json({ ok: true });
});

app.post("/api/config", (req: Request, res: Response) => {
  try {
    const { field, value } = req.body ?? {};

    if (!field) {
      return res.status(400).json({ error: "field obrigatório" });
    }

    const BLOCKED = ["privateKey", "PRIVATE_KEY"];
    if (BLOCKED.includes(field)) {
      return res.status(403).json({ error: "Campo bloqueado" });
    }

    bot.updateConfig(field, value);

    return res.json({ ok: true, field, value });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

app.post("/api/emergency-stop", async (_req: Request, res: Response) => {
  await bot.emergencyStop();
  return res.json({ ok: true });
});

// ── SSE ───────────────────────────────────────

app.get("/api/logs/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 15000);

  sseClients.add(res);

  broadcastLog("info", `SSE conectado (${sseClients.size})`);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// ─────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 Server rodando: http://localhost:${PORT}`);
  console.log(`📡 API: http://localhost:${PORT}/api/status\n`);
});