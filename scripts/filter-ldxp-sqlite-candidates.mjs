#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

loadEnv(path.join(repoRoot, ".env.local"));

const options = parseArgs(process.argv.slice(2));
const dbPath = options.db || process.env.LDXP_SQLITE_PATH;
if (!dbPath) {
  console.error("Missing --db <path> or LDXP_SQLITE_PATH.");
  process.exit(1);
}

const outPath = path.resolve(
  repoRoot,
  options.out || "docs/planning/ldxp-sqlite-channel-candidates.md",
);
const jsonOutPath = options.jsonOut
  ? path.resolve(repoRoot, options.jsonOut)
  : outPath.replace(/\.md$/i, ".json");

const minNameScore = numberOption(options.minScore, 2);
const probeMode = Boolean(options.probe);
const probeLimit = numberOption(options.limit, probeMode ? 80 : 0);
const probeDelayMs = numberOption(options.delayMs, 3000);
const probeTimeoutMs = numberOption(options.timeoutMs, 12_000);
const candidateMode = options.candidate || "name-related";

const merchants = readMerchants(dbPath).map((merchant) => {
  const scored = scoreText(merchant.merchant_name);
  return {
    id: merchant.id,
    name: cleanText(merchant.merchant_name),
    url: cleanText(merchant.shop_url),
    updatedAt: cleanText(merchant.updated_at),
    normalizedUrl: normalizeSourceUrl(merchant.shop_url),
    shopToken: shopTokenFromUrl(merchant.shop_url),
    nameScore: scored.score,
    nameHits: scored.hits,
    negativeHits: scored.negativeHits,
  };
});

const existingSources = await loadExistingSources();
const existingByUrl = new Map();
for (const source of existingSources) {
  const key = normalizeSourceUrl(source.entry_url || source.base_url || "");
  if (!key) continue;
  const items = existingByUrl.get(key) || [];
  items.push(source);
  existingByUrl.set(key, items);
}

const candidates = merchants.map((merchant) => ({
  ...merchant,
  duplicateSources: existingByUrl.get(merchant.normalizedUrl) || [],
}));

const newCandidates = candidates.filter((candidate) => candidate.duplicateSources.length === 0);
const candidatePool = selectCandidatePool(newCandidates, candidateMode, minNameScore);
const probeTargets = probeMode ? candidatePool.slice(0, probeLimit || candidatePool.length) : [];
const probeResults = probeMode
  ? await probeSequentially(probeTargets, { delayMs: probeDelayMs, timeoutMs: probeTimeoutMs })
  : new Map();

const analyzed = candidates.map((candidate) => {
  const probe = probeResults.get(candidate.normalizedUrl) || null;
  const titleScore = scoreText((probe?.offers || []).map((offer) => offer.title).join(" "));
  const aiScore = candidate.nameScore + titleScore.score;
  const aiHits = unique([...candidate.nameHits, ...titleScore.hits]);

  return {
    ...candidate,
    probe,
    titleScore: titleScore.score,
    titleHits: titleScore.hits,
    aiScore,
    aiHits,
    group: classifyCandidate(candidate, probe, aiScore, minNameScore),
  };
});

const report = buildReport({
  dbPath,
  outPath,
  jsonOutPath,
  options: {
    probeMode,
    probeLimit,
    probeDelayMs,
    probeTimeoutMs,
    minNameScore,
    candidateMode,
  },
  merchants,
  existingSources,
  analyzed,
  probeTargets,
});

await mkdir(path.dirname(outPath), { recursive: true });
await mkdir(path.dirname(jsonOutPath), { recursive: true });
await writeFile(outPath, renderMarkdown(report), "utf8");
await writeFile(jsonOutPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`Wrote ${path.relative(repoRoot, outPath)}`);
console.log(`Wrote ${path.relative(repoRoot, jsonOutPath)}`);
console.log(JSON.stringify(report.summary, null, 2));

function readMerchants(filePath) {
  const sql = "select id, merchant_name, shop_url, updated_at from merchants order by id";
  const output = execFileSync("sqlite3", ["-json", filePath, sql], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  return JSON.parse(output || "[]");
}

async function loadExistingSources() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return [];

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase
    .from("sources")
    .select("id,name,entry_url,base_url,enabled,collector_kind,health_status,last_success_at,last_checked_at")
    .order("name", { ascending: true });

  if (error) throw error;
  return data || [];
}

function selectCandidatePool(items, mode, minScore) {
  const filtered = items.filter((item) => {
    if (!item.shopToken) return false;
    if (item.negativeHits.length) return false;
    if (mode === "all-new") return true;
    if (mode === "strong-name") return item.nameScore >= 5;
    return item.nameScore >= minScore;
  });

  return filtered.sort((a, b) => b.nameScore - a.nameScore || a.id - b.id);
}

async function probeSequentially(items, config) {
  const results = new Map();

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const result = await probeLdxpShop(item, config).catch((error) => ({
      status: "failed",
      message: errorMessage(error),
      offerCount: 0,
      offers: [],
    }));
    results.set(item.normalizedUrl, result);

    console.error(
      `[${index + 1}/${items.length}] ${item.name} -> ${result.status}` +
        (result.offerCount ? ` (${result.offerCount})` : "") +
        (result.message ? `: ${result.message}` : ""),
    );

    if (index < items.length - 1 && config.delayMs > 0) {
      await delay(config.delayMs);
    }
  }

  return results;
}

async function probeLdxpShop(item, config) {
  const baseUrl = "https://pay.ldxp.cn";
  const info = await postShopJson(
    `${baseUrl}/shopApi/Shop/info`,
    { token: item.shopToken, category_key: "" },
    item.url,
    config.timeoutMs,
  );

  if (info.code !== 1 || !info.data) {
    return {
      status: "inactive",
      message: cleanText(info.msg || info.message || "店铺链接不存在或不可用"),
      offerCount: 0,
      offers: [],
    };
  }

  const storeName = cleanText(info.data.nickname || item.name);
  const sourceUrl = cleanText(info.data.link || item.url);
  const categoriesPayload = await postShopJson(
    `${baseUrl}/shopApi/Shop/categoryList`,
    { token: item.shopToken, goods_type: "card", category_key: "" },
    sourceUrl || item.url,
    config.timeoutMs,
  );
  const categories = Array.isArray(categoriesPayload.data) ? categoriesPayload.data : [];
  const selectedCategories = categories
    .filter((category) => Number(category.goods_count || 0) > 0 && Number(category.id) !== 0)
    .slice(0, 4);

  if (!selectedCategories.length) {
    return {
      status: "empty",
      message: "店铺可访问，但未发现有商品的分类。",
      storeName,
      offerCount: 0,
      categoryCount: categories.length,
      offers: [],
    };
  }

  const offers = [];
  for (const category of selectedCategories) {
    const listPayload = await postShopJson(
      `${baseUrl}/shopApi/Shop/goodsList`,
      {
        token: item.shopToken,
        keywords: "",
        category_id: Number(category.id),
        goods_type: "card",
        current: 1,
        pageSize: 30,
      },
      sourceUrl || item.url,
      config.timeoutMs,
    );
    const list = Array.isArray(listPayload.data?.list) ? listPayload.data.list : [];
    for (const product of list) {
      const title = cleanText(product.name);
      const price = numberOrNull(product.price ?? product.real_price);
      if (!title || price === null) continue;
      offers.push({
        title,
        price,
        status: Number(product.status ?? 1) !== 1 ? "out_of_stock" : statusFromStock(product.extend?.stock_count),
        stockCount: numberOrNull(product.extend?.stock_count),
        category: cleanText(product.category?.name || category.name || ""),
        url: cleanText(product.link || `${baseUrl}/item/${product.goods_key || ""}`),
      });
    }
  }

  return {
    status: offers.length ? "success" : "empty",
    message: offers.length ? "" : "店铺可访问，但未读取到商品。",
    storeName,
    sourceUrl,
    offerCount: offers.length,
    categoryCount: categories.length,
    nonEmptyCategoryCount: selectedCategories.length,
    offers: offers.slice(0, 20),
  };
}

async function postShopJson(url, body, referer, timeoutMs) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
      "content-type": "application/json",
      origin: "https://pay.ldxp.cn",
      referer,
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      visitorid: `ldxp${Math.random().toString(36).slice(2, 10)}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  try {
    return JSON.parse(text);
  } catch {
    if (/<html|<script|captcha|challenge|验证|风控|安全/i.test(text)) {
      throw new Error("返回验证或风控页面，需要稍后低频复查。");
    }
    throw new Error("返回非 JSON 内容。");
  }
}

function classifyCandidate(candidate, probe, aiScore, minScore) {
  if (candidate.duplicateSources.length) return "duplicate_existing";
  if (candidate.negativeHits.length) return "ignored_negative_name";
  if (!probe) return candidate.nameScore >= minScore ? "needs_slow_probe" : "ignored_low_relevance";
  if (probe.status === "success" && probe.offerCount > 0 && aiScore >= minScore) return "confirmed_ai_increment";
  if (probe.status === "success" && probe.offerCount > 0) return "needs_manual_review";
  if (probe.status === "empty") return "empty_shop";
  if (probe.status === "inactive") return "inactive_shop";
  return candidate.nameScore >= minScore ? "needs_slow_probe" : "probe_failed_low_relevance";
}

function buildReport(input) {
  const groups = groupBy(input.analyzed, (item) => item.group);
  const summary = {
    generatedAt: new Date().toISOString(),
    sqliteRows: input.merchants.length,
    existingSourceCount: input.existingSources.length,
    duplicateExistingCount: groups.duplicate_existing?.length || 0,
    newCandidateCount: input.analyzed.filter((item) => !item.duplicateSources.length).length,
    nameRelatedNewCount: input.analyzed.filter(
      (item) => !item.duplicateSources.length && item.nameScore >= input.options.minNameScore && !item.negativeHits.length,
    ).length,
    probedCount: input.probeTargets.length,
    confirmedAiIncrementCount: groups.confirmed_ai_increment?.length || 0,
    needsSlowProbeCount: groups.needs_slow_probe?.length || 0,
    emptyShopCount: groups.empty_shop?.length || 0,
    inactiveShopCount: groups.inactive_shop?.length || 0,
  };

  return {
    summary,
    input: {
      dbPath: input.dbPath,
      outPath: input.outPath,
      jsonOutPath: input.jsonOutPath,
      options: input.options,
    },
    groups: {
      confirmedAiIncrement: compactCandidates(groups.confirmed_ai_increment || [], 120),
      needsSlowProbe: compactCandidates(groups.needs_slow_probe || [], 180),
      needsManualReview: compactCandidates(groups.needs_manual_review || [], 80),
      emptyShop: compactCandidates(groups.empty_shop || [], 80),
      inactiveShop: compactCandidates(groups.inactive_shop || [], 80),
      ignoredNegativeName: compactCandidates(groups.ignored_negative_name || [], 80),
      ignoredLowRelevance: compactCandidates(groups.ignored_low_relevance || [], 120),
      duplicates: compactCandidates(groups.duplicate_existing || [], 80),
    },
  };
}

function compactCandidates(items, limit) {
  return items.slice(0, limit).map((item) => ({
    id: item.id,
    name: item.name,
    url: item.url,
    score: item.aiScore,
    nameScore: item.nameScore,
    titleScore: item.titleScore,
    hits: item.aiHits,
    probeStatus: item.probe?.status || null,
    offerCount: item.probe?.offerCount || 0,
    storeName: item.probe?.storeName || null,
    message: item.probe?.message || null,
    sampleOffers: (item.probe?.offers || []).slice(0, 5),
    duplicateSources: item.duplicateSources.map((source) => ({
      id: source.id,
      name: source.name,
      enabled: source.enabled,
    })),
  }));
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# LDXP SQLite 渠道候选筛选报告");
  lines.push("");
  lines.push(`生成时间：${report.summary.generatedAt}`);
  lines.push("");
  lines.push("## 摘要");
  lines.push("");
  lines.push(`- SQLite 商户数：${report.summary.sqliteRows}`);
  lines.push(`- 现有渠道数：${report.summary.existingSourceCount}`);
  lines.push(`- 已存在重复：${report.summary.duplicateExistingCount}`);
  lines.push(`- 增量候选：${report.summary.newCandidateCount}`);
  lines.push(`- 店名疑似 AI 相关增量：${report.summary.nameRelatedNewCount}`);
  lines.push(`- 本次试采集数量：${report.summary.probedCount}`);
  lines.push(`- 已确认 AI 增量：${report.summary.confirmedAiIncrementCount}`);
  lines.push(`- 仍需低频复查：${report.summary.needsSlowProbeCount}`);
  lines.push(`- 空店：${report.summary.emptyShopCount}`);
  lines.push(`- 店铺不可用：${report.summary.inactiveShopCount}`);
  lines.push("");
  lines.push("## 已确认 AI 增量");
  lines.push("");
  appendCandidateTable(lines, report.groups.confirmedAiIncrement);
  lines.push("");
  lines.push("## 待低频复查");
  lines.push("");
  lines.push("这些候选店名相关，但未在本次试采集中确认。遇到 pay.ldxp.cn 风控时，不应直接判定为关闭。");
  lines.push("");
  appendCandidateTable(lines, report.groups.needsSlowProbe);
  lines.push("");
  lines.push("## 空店 / 不可用");
  lines.push("");
  appendCandidateTable(lines, [...report.groups.emptyShop, ...report.groups.inactiveShop]);
  lines.push("");
  lines.push("## 已存在重复示例");
  lines.push("");
  appendCandidateTable(lines, report.groups.duplicates);
  lines.push("");
  lines.push("## 运行参数");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(report.input.options, null, 2));
  lines.push("```");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function appendCandidateTable(lines, items) {
  if (!items.length) {
    lines.push("暂无。");
    return;
  }

  lines.push("| 店铺 | 链接 | 分数 | 试采集 | 商品数 | 示例商品 |");
  lines.push("|---|---|---:|---|---:|---|");
  for (const item of items) {
    lines.push(
      `| ${escapeTable(item.name)} | ${escapeTable(item.url)} | ${item.score} | ${escapeTable(item.probeStatus || "-")} | ${item.offerCount} | ${escapeTable(sampleOfferText(item))} |`,
    );
  }
}

function sampleOfferText(item) {
  const titles = (item.sampleOffers || []).slice(0, 2).map((offer) => `${offer.title} / ${offer.price}`);
  if (titles.length) return titles.join("；");
  if (item.message) return item.message;
  if (item.duplicateSources?.length) return `已存在：${item.duplicateSources.map((source) => source.name).join("、")}`;
  return "-";
}

function scoreText(value) {
  const text = cleanText(value);
  const hits = [];
  const negativeHits = [];
  let score = 0;

  const positiveRules = [
    ["ChatGPT/OpenAI", /chat\s*gpt|chatgpt|\bgpt\b|openai|codex|gpt\s*plus|gpt\s*pro|team|business/i, 5],
    ["Gemini/Google", /gemini|google\s*(one|ai|pro|ultra)|pixel/i, 5],
    ["Claude", /claude|anthropic/i, 5],
    ["Grok", /grok|xai/i, 5],
    ["API/CDK", /api|中转|额度|兑换码|cdk|\d+\s*刀/i, 4],
    ["AI 工具账号", /cursor|windsurf|kiro|midjourney|notion|canva|perplexity|poe/i, 4],
    ["邮箱", /gmail|outlook|邮箱|google\s*mail|mail/i, 4],
    ["渠道词", /ai|源头|批发|账号|会员|代充|直充|供应商|成品号|订阅/i, 2],
  ];

  const negativeRules = [
    ["游戏/吃丹", /吃丹|和平精英|王者|游戏|手游|外挂|脚本|守望先锋|修仙|口播智能体/i],
    ["泛内容/素材", /素材|写真|抖音|快手|qq等级|资源|短剧/i],
  ];

  for (const [label, pattern, weight] of positiveRules) {
    if (pattern.test(text)) {
      hits.push(label);
      score += weight;
    }
  }

  for (const [label, pattern] of negativeRules) {
    if (pattern.test(text)) {
      negativeHits.push(label);
      score -= 5;
    }
  }

  return { score, hits, negativeHits };
}

function shopTokenFromUrl(value) {
  try {
    const match = new URL(value).pathname.match(/\/shop\/([^/?#]+)/i);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

function normalizeSourceUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.protocol = "https:";
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return cleanText(value).toLowerCase().replace(/\/+$/, "");
  }
}

function statusFromStock(value) {
  const stockCount = numberOrNull(value);
  if (stockCount === null) return "in_stock";
  return stockCount > 0 ? "in_stock" : "out_of_stock";
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function escapeTable(value) {
  return cleanText(value).replace(/\|/g, "\\|");
}

function groupBy(items, keyFn) {
  const groups = {};
  for (const item of items) {
    const key = keyFn(item);
    groups[key] ||= [];
    groups[key].push(item);
  }
  return groups;
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function numberOption(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (!arg.startsWith("--")) continue;
    const key = camelCase(arg.slice(2));
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function loadEnv(filePath) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index);
    const value = trimmed.slice(index + 1).replace(/^['"]|['"]$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
