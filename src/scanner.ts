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
  cookin?: CookinData;
}

interface CookinData {
  score: number;
  conviction_score: number;
  bundle_pct: number;
  alpha_hands_pct: number;
  diamond_hands_pct: number;
  chart_nukers_pct: number;
  jeets_pct: number;
  dirty_pct: number;
  pump_conditions_met: number;
  dump_conditions_met: number;
  kols_in_count: number;
  holder_count: number;
  bundle_count: number;
  top10_pct: number;
  dex_paid: boolean;
  has_migrated: boolean;
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

  // Cookin.fun enrichment (optional)
  COOKIN_API_KEY: process.env.COOKIN_API_KEY ?? "",
  COOKIN_BASE_URL: process.env.COOKIN_BASE_URL ?? "https://api.cookin.fun",
  COOKIN_MIN_SCORE: Number(process.env.COOKIN_MIN_SCORE ?? 3),
  COOKIN_MAX_DUMP: Number(process.env.COOKIN_MAX_DUMP_CONDITIONS ?? 15),
  COOKIN_MAX_BUNDLE_PCT: Number(process.env.COOKIN_MAX_BUNDLE_PCT ?? 60),
  COOKIN_REQUIRE_DEX_PAID: process.env.COOKIN_REQUIRE_DEX_PAID !== "false",

  // Cookin.fun enrichment timeout per token (ms)
  COOKIN_TIMEOUT: Number(process.env.COOKIN_TIMEOUT ?? 8000),
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
      if (c.cookin) {
        meta.push(`🍳S:${c.cookin.score.toFixed(1)} d:${c.cookin.dump_conditions_met} b:${c.cookin.bundle_pct.toFixed(0)}%`);
        if (c.cookin.kols_in_count > 0) meta.push(`KOL:${c.cookin.kols_in_count}`);
      }
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

// ── Cookin.fun Enrichment ───────────────────────────────────────────────────

async function cookinSnapshot(mint: string): Promise<CookinData | null> {
  if (!CONFIG.COOKIN_API_KEY) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.COOKIN_TIMEOUT);

  try {
    const resp = await fetch(`${CONFIG.COOKIN_BASE_URL}/v1/tokens/${mint}`, {
      headers: { Authorization: `Bearer ${CONFIG.COOKIN_API_KEY}` },
      signal: controller.signal,
    });
    if (!resp.ok) return null;

    const json = await resp.json() as { data?: Record<string, unknown> };
    const d = json.data ?? {};
    const score = d.score as Record<string, number> | undefined;
    const holders = d.holders as Record<string, unknown> | undefined;
    const bundles = d.bundles as unknown[] | undefined;
    const signals = d.signals as Record<string, number> | undefined;
    const status = d.status as Record<string, boolean | null> | undefined;
    const kols = d.kols as Record<string, unknown> | undefined;

    return {
      score: score?.value ?? 0,
      conviction_score: score?.conviction_score ?? 0,
      bundle_pct: score?.bundle_pct ?? 0,
      alpha_hands_pct: score?.alpha_hands_pct ?? 0,
      diamond_hands_pct: score?.diamond_hands_pct ?? 0,
      chart_nukers_pct: score?.chart_nukers_pct ?? 0,
      jeets_pct: score?.jeets_pct ?? 0,
      dirty_pct: score?.dirty_pct ?? 0,
      pump_conditions_met: signals?.pump_conditions_met ?? 0,
      dump_conditions_met: signals?.dump_conditions_met ?? 0,
      kols_in_count: (kols?.count as number) ?? 0,
      holder_count: (holders?.count as number) ?? 0,
      bundle_count: bundles?.length ?? 0,
      top10_pct: (holders?.top_10_pct as number) ?? 0,
      dex_paid: (status?.dex_paid as boolean) ?? false,
      has_migrated: (status?.has_migrated as boolean) ?? false,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function passesCookin(c: CookinData): string[] {
  const reasons: string[] = [];
  if (c.score < CONFIG.COOKIN_MIN_SCORE)
    reasons.push(`score ${c.score.toFixed(1)} < ${CONFIG.COOKIN_MIN_SCORE}`);
  if (c.dump_conditions_met > CONFIG.COOKIN_MAX_DUMP)
    reasons.push(`dump signals ${c.dump_conditions_met} > ${CONFIG.COOKIN_MAX_DUMP}`);
  if (c.bundle_pct > CONFIG.COOKIN_MAX_BUNDLE_PCT)
    reasons.push(`bundle ${c.bundle_pct.toFixed(0)}% > ${CONFIG.COOKIN_MAX_BUNDLE_PCT}%`);
  if (CONFIG.COOKIN_REQUIRE_DEX_PAID && !c.dex_paid)
    reasons.push("DEX not paid");
  return reasons;
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

  // Enrich with Cookin.fun data
  if (CONFIG.COOKIN_API_KEY) {
    console.error(`[cookin] enriching ${top.length} candidates...`);
    for (const c of top) {
      const data = await cookinSnapshot(c.address);
      if (data) {
        c.cookin = data;
        const failReasons = passesCookin(data);
        if (failReasons.length > 0) {
          console.error(`[cookin] ⚠ ${c.symbol} score=${data.score.toFixed(1)} dump=${data.dump_conditions_met} bundle=${data.bundle_pct.toFixed(0)}% — FAILED: ${failReasons.join(", ")}`);
        } else {
          console.error(`[cookin] ✓ ${c.symbol} score=${data.score.toFixed(1)} dump=${data.dump_conditions_met} bundle=${data.bundle_pct.toFixed(0)}% kols=${data.kols_in_count}`);
        }
      } else {
        console.error(`[cookin] ⚠ ${c.symbol} — no data (API error or timeout)`);
      }
    }
  }

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
