#!/usr/bin/env node
/**
 * GMGN Scanner for LP
 * ====================
 * Standalone scanner that queries GMGN trending, applies midcap-degen filters,
 * and outputs structured JSON candidates for downstream LP execution.
 *
 * Zero execution — no minting, no transactions, no private keys.
 *
 * Usage:
 *   npm run scan
 *   CHAIN=ethereum MIN_VOLUME_USD=500000 npm run scan
 *
 * Output: JSON array of candidates to stdout
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// ── Types ──────────────────────────────────────────────────────────────────

interface GmgnRankItem {
  address: string;
  symbol: string;
  name: string;
  price: number;
  volume: number;
  liquidity: number;
  market_cap: number;
  holder_count: number;
  smart_degen_count: number;
  is_wash_trading: boolean;
  rug_ratio?: number;
  launchpad_platform?: string;
  creator_token_status?: string;
  open_timestamp?: number;
}

interface FilterRejection {
  token: string;
  symbol: string;
  reasons: string[];
}

interface ScanCandidate {
  address: string;
  symbol: string;
  name: string;
  price: number;
  volume_5m: number;
  liquidity: number;
  market_cap: number;
  holder_count: number;
  smart_degen_count: number;
  is_wash_trading: boolean;
  rug_ratio?: number;
  launchpad_platform?: string;
  open_timestamp?: number;
}

interface ScanResult {
  timestamp: string;
  chain: string;
  filters: {
    min_volume_5m: number;
    max_volume_5m: number;
    min_holders: number;
    min_smart_degen: number;
    reject_wash_trading: boolean;
  };
  stats: {
    total_trending: number;
    passed: number;
    rejected: number;
  };
  candidates: ScanCandidate[];
  rejected: FilterRejection[];
}

// ── Config (env with defaults) ─────────────────────────────────────────────

const CONFIG = {
  GMGN_CLI: process.env.GMGN_CLI_PATH ?? "/usr/local/bin/gmgn-cli",
  GMGN_API_KEY: process.env.GMGN_API_KEY ?? "gmgn_solbscbaseethmonadtron",
  CHAIN: process.env.CHAIN ?? "robinhood",

  // GMGN CLI chain alias map (e.g. solana → sol)
  CHAIN_ALIASES: { solana: "sol" } as Record<string, string>,

  // Filter params
  MIN_VOLUME: Number(process.env.MIN_VOLUME_USD ?? 200_000),
  MAX_VOLUME: Number(process.env.MAX_VOLUME_USD ?? 1_000_000),
  MIN_HOLDERS: Number(process.env.MIN_HOLDERS ?? 750),
  MIN_SMART_DEGEN: Number(process.env.MIN_SMART_DEGEN ?? 1),
  REJECT_WASH: process.env.REJECT_WASH_TRADING !== "false",
  MAX_CANDIDATES: Number(process.env.MAX_CANDIDATES ?? 5),

  OUTPUT: (process.env.OUTPUT_FORMAT ?? "json") as "json" | "pretty",

  // GMGN trending interval: 1m | 5m | 1h | 6h | 24h
  INTERVAL: process.env.INTERVAL ?? "5m",
} as const;

// ── GMGN API ───────────────────────────────────────────────────────────────

async function gmgnTrending(
  interval = "5m",
  limit = 50
): Promise<GmgnRankItem[]> {
  const gmgnChain = CONFIG.CHAIN_ALIASES[CONFIG.CHAIN] ?? CONFIG.CHAIN;

  const args = [
    "market",
    "trending",
    "--chain",
    gmgnChain,
    "--interval",
    CONFIG.INTERVAL,
    "--limit",
    String(limit),
    "--order-by",
    "volume",
    "--raw",
  ];

  const { stdout } = await execFileP(CONFIG.GMGN_CLI, args, {
    env: { ...process.env, GMGN_API_KEY: CONFIG.GMGN_API_KEY },
    timeout: 30_000,
  });

  const parsed = JSON.parse(stdout) as { data?: { rank?: GmgnRankItem[] } };
  const rank = parsed.data?.rank ?? [];

  return rank.map((r) => ({
    ...r,
    volume: Number(r.volume ?? 0),
    liquidity: Number(r.liquidity ?? 0),
    market_cap: Number(r.market_cap ?? 0),
    holder_count: Number(r.holder_count ?? 0),
    smart_degen_count: Number(r.smart_degen_count ?? 0),
    is_wash_trading: !!r.is_wash_trading,
  }));
}

// ── Filter ─────────────────────────────────────────────────────────────────

function passesFilter(t: GmgnRankItem): string[] {
  const reasons: string[] = [];
  if (t.volume < CONFIG.MIN_VOLUME)
    reasons.push(
      `vol $${(t.volume / 1000).toFixed(0)}K < $${(CONFIG.MIN_VOLUME / 1000).toFixed(0)}K`
    );
  if (t.volume > CONFIG.MAX_VOLUME)
    reasons.push(
      `vol $${(t.volume / 1000).toFixed(0)}K > $${(CONFIG.MAX_VOLUME / 1000).toFixed(0)}K`
    );
  if (t.holder_count < CONFIG.MIN_HOLDERS)
    reasons.push(`holders ${t.holder_count} < ${CONFIG.MIN_HOLDERS}`);
  if (t.smart_degen_count < CONFIG.MIN_SMART_DEGEN)
    reasons.push(
      `smart ${t.smart_degen_count} < ${CONFIG.MIN_SMART_DEGEN}`
    );
  if (CONFIG.REJECT_WASH && t.is_wash_trading) reasons.push("wash trading");
  return reasons;
}

// ── Formatter ──────────────────────────────────────────────────────────────

function toCandidate(t: GmgnRankItem): ScanCandidate {
  return {
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    price: t.price,
    volume_5m: t.volume,
    liquidity: t.liquidity,
    market_cap: t.market_cap,
    holder_count: t.holder_count,
    smart_degen_count: t.smart_degen_count,
    is_wash_trading: t.is_wash_trading,
    rug_ratio: t.rug_ratio,
    launchpad_platform: t.launchpad_platform,
    open_timestamp: t.open_timestamp,
  };
}

function formatResult(result: ScanResult): string {
  if (CONFIG.OUTPUT === "pretty") {
    const lines: string[] = [];
    lines.push("╔══════════════════════════════════════════╗");
    lines.push(`║  GMGN Scanner — ${result.chain.padEnd(17)}       ║`);
    lines.push("╠══════════════════════════════════════════╣");
    lines.push(
      `║  Trending: ${String(result.stats.total_trending).padEnd(3)}  Pass: ${String(result.stats.passed).padEnd(3)}  Reject: ${String(result.stats.rejected).padEnd(3)}  ║`
    );
    lines.push("╠══════════════════════════════════════════╣");

    for (const c of result.candidates) {
      lines.push(`║  ${c.symbol.padEnd(8)} vol $${(c.volume_5m / 1000).toFixed(0)}K │ h${c.holder_count} │ s${c.smart_degen_count}`);
      lines.push(`║  CA: ${c.address.slice(0, 20)}...`);
      const meta = [];
      if (c.launchpad_platform) meta.push(c.launchpad_platform);
      if (c.rug_ratio !== undefined && c.rug_ratio > 0) meta.push(`rug:${c.rug_ratio.toFixed(2)}`);
      lines.push(`║  Liq: $${(c.liquidity / 1000).toFixed(1)}K  MC: $${(c.market_cap / 1000).toFixed(1)}K  ${meta.join(" ")}`);
    }

    if (result.candidates.length === 0) {
      lines.push("║  (no candidates this cycle)              ║");
    }

    lines.push("╚══════════════════════════════════════════╝");
    return lines.join("\n");
  }

  // JSON output
  return JSON.stringify(result, null, 2);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function scan(): Promise<ScanResult> {
  const items = await gmgnTrending(CONFIG.INTERVAL, 50);

  const candidates: ScanCandidate[] = [];
  const rejected: FilterRejection[] = [];

  for (const item of items) {
    const reasons = passesFilter(item);
    if (reasons.length === 0) {
      candidates.push(toCandidate(item));
    } else {
      rejected.push({
        token: item.address,
        symbol: item.symbol,
        reasons,
      });
    }
  }

  // Sort by volume descending, take top N
  candidates.sort((a, b) => b.volume_5m - a.volume_5m);
  const top = candidates.slice(0, CONFIG.MAX_CANDIDATES);

  return {
    timestamp: new Date().toISOString(),
    chain: CONFIG.CHAIN,
    filters: {
      min_volume_5m: CONFIG.MIN_VOLUME,
      max_volume_5m: CONFIG.MAX_VOLUME,
      min_holders: CONFIG.MIN_HOLDERS,
      min_smart_degen: CONFIG.MIN_SMART_DEGEN,
      reject_wash_trading: CONFIG.REJECT_WASH,
    },
    stats: {
      total_trending: items.length,
      passed: candidates.length,
      rejected: rejected.length,
    },
    candidates: top,
    rejected,
  };
}

// ── Entry ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.error(`[gmgn-scanner] chain=${CONFIG.CHAIN} vol=$${CONFIG.MIN_VOLUME / 1000}K-$${CONFIG.MAX_VOLUME / 1000}K h≥${CONFIG.MIN_HOLDERS} s≥${CONFIG.MIN_SMART_DEGEN}`);
  const result = await scan();
  console.log(formatResult(result));
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
