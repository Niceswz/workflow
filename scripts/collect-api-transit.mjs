#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { safeFetch } from "./safe-fetch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const configPath = path.join(repoRoot, "config", "api-transit-sources.json");
const defaultOutPath = path.join(repoRoot, "data", "api-transit", "latest-public-pricing.json");

const userAgent = "Mozilla/5.0 PriceAI/1.0 APITransitCollector";
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_RECHARGE_RATIO = "1:1";
const NEW_API_USD_UNIT_PRICE_FACTOR = 2;
const officialTransitPrices = {
  "Claude Sonnet 4.6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "Claude Opus 4.6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "Claude Opus 4.7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "Claude Opus 4.8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "GPT 5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0.5 },
  "GPT 5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0.25 },
};

if (isCli()) {
  const args = normalizeOptions(parseArgs(process.argv.slice(2)));

  try {
    const result = await collectApiTransitPrices(args);
    printSummary(result);

    if (args.dryRun) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const outPath = path.resolve(repoRoot, args.out || defaultOutPath);
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      console.log(`Snapshot written to ${path.relative(repoRoot, outPath)}`);
    }
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
}

export async function collectApiTransitPrices(options = {}) {
  options = normalizeOptions(options);

  const selectedSources = selectSources(loadSources(), options);
  const startedAt = new Date().toISOString();
  const stations = [];
  const offers = [];
  const runs = [];

  for (const source of selectedSources) {
    const runStartedAt = new Date().toISOString();
    try {
      const payload = await fetchPricingJson(source, options);
      const parsed = parsePricingPayload(source, payload, runStartedAt);
      stations.push(parsed.station);
      offers.push(...parsed.offers);
      runs.push({
        id: stableId("api-transit-run", source.id, runStartedAt),
        station_id: source.id,
        run_type: "public_pricing",
        status: parsed.offers.length ? "success" : "partial",
        model_count: parsed.modelCount,
        offer_count: parsed.offers.length,
        error_message: parsed.offers.length ? null : "未识别到 Claude/GPT MVP 模型。",
        source_url: source.pricingEndpointUrl,
        started_at: runStartedAt,
        finished_at: new Date().toISOString(),
        raw_snapshot: compactSnapshot(payload),
        logs: {
          collectorKind: source.collectorKind,
          selectedModels: parsed.offers.map((offer) => offer.raw_model_name),
        },
      });
    } catch (error) {
      stations.push(buildStationRow(source, runStartedAt, { status: "failed", error: errorMessage(error) }));
      runs.push({
        id: stableId("api-transit-run", source.id, runStartedAt),
        station_id: source.id,
        run_type: "public_pricing",
        status: "failed",
        model_count: 0,
        offer_count: 0,
        error_message: errorMessage(error),
        source_url: source.pricingEndpointUrl,
        started_at: runStartedAt,
        finished_at: new Date().toISOString(),
        raw_snapshot: {},
        logs: { collectorKind: source.collectorKind },
      });
    }
  }

  const result = {
    dryRun: Boolean(options.dryRun),
    post: Boolean(options.post || options.db),
    publish: Boolean(options.publish),
    source: "api_transit_public_pricing",
    generatedAt: new Date().toISOString(),
    startedAt,
    counts: {
      sources: selectedSources.length,
      stations: stations.length,
      offers: offers.length,
      runs: runs.length,
    },
    stations,
    offers,
    runs,
  };

  if (options.post || options.db) {
    result.database = await postRows({ stations, offers, runs }, options);
  }

  return result;
}

async function fetchPricingJson(source, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  try {
    const response = await safeFetch(source.pricingEndpointUrl, {
      signal: controller.signal,
      headers: {
        "accept": "application/json,text/plain;q=0.9,*/*;q=0.8",
        "user-agent": userAgent,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("公开价格接口没有返回 JSON。");
    }
  } finally {
    clearTimeout(timeout);
  }
}

function parsePricingPayload(source, payload, collectedAt) {
  const items = normalizePricingItems(payload);
  const groupRatios = normalizeGroupRatios(payload);
  const selected = [];

  for (const item of items) {
    const standard = standardizeModelName(item.model_name || item.name || "");
    if (!standard) continue;

    const groups = normalizeItemGroups(item, groupRatios);
    for (const group of groups) {
      const offer = buildOfferRow(source, item, group, standard, collectedAt);
      if (offer) selected.push(offer);
    }
  }

  const deduped = dedupeBestOffers(selected);
  return {
    modelCount: items.length,
    station: buildStationRow(source, collectedAt, {
      status: deduped.length ? "success" : "partial",
      offerCount: deduped.length,
    }),
    offers: deduped,
  };
}

function normalizePricingItems(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.models)) return payload.models;
  const modelInfo = payload?.data?.model_info || payload?.model_info;
  if (Array.isArray(modelInfo)) return modelInfo;
  if (modelInfo && typeof modelInfo === "object") return Object.values(modelInfo);
  return [];
}

function normalizeGroupRatios(payload) {
  const raw = payload?.group_ratio || payload?.data?.group_info || payload?.group_info || {};
  const groups = new Map();
  if (!raw || typeof raw !== "object") return groups;

  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number") {
      groups.set(key, { name: key, ratio: value, description: null });
    } else if (value && typeof value === "object") {
      groups.set(key, {
        name: String(value.DisplayName || value.display_name || key),
        ratio: numberValue(value.GroupRatio ?? value.group_ratio ?? value.ratio),
        description: value.Description || value.description || null,
      });
    }
  }
  return groups;
}

function normalizeItemGroups(item, groupRatios) {
  if (item.price_info && typeof item.price_info === "object") {
    const groups = [];
    for (const [groupName, groupPayload] of Object.entries(item.price_info)) {
      const defaultPayload = groupPayload?.default && typeof groupPayload.default === "object" ? groupPayload.default : groupPayload;
      const meta = groupRatios.get(groupName) || { name: groupName, ratio: null, description: null };
      groups.push({
        key: groupName,
        name: meta.name || groupName,
        groupRatio: meta.ratio,
        description: meta.description,
        modelRatio: numberValue(defaultPayload?.model_ratio),
        completionRatio: numberValue(defaultPayload?.model_completion_ratio ?? defaultPayload?.completion_ratio),
        cacheRatio: numberValue(defaultPayload?.model_cache_ratio ?? defaultPayload?.cache_ratio),
        createCacheRatio: numberValue(defaultPayload?.model_create_cache_ratio ?? defaultPayload?.create_cache_ratio),
      });
    }
    return groups;
  }

  const enableGroups = Array.isArray(item.enable_groups) && item.enable_groups.length ? item.enable_groups : ["default"];
  return enableGroups.map((groupName) => {
    const meta = groupRatios.get(groupName) || { name: groupName, ratio: null, description: null };
    return {
      key: groupName,
      name: meta.name || groupName,
      groupRatio: meta.ratio,
      description: meta.description,
      modelRatio: numberValue(item.model_ratio),
      completionRatio: numberValue(item.completion_ratio),
      cacheRatio: numberValue(item.cache_ratio),
      createCacheRatio: numberValue(item.create_cache_ratio),
    };
  });
}

function buildStationRow(source, collectedAt, collection = {}) {
  const status = collection.status === "failed" ? "failed" : collection.status === "success" ? "success" : "partial";
  return {
    id: source.id,
    slug: source.slug || source.id,
    name: source.name,
    website_url: source.websiteUrl,
    api_base_url: source.apiBaseUrl || null,
    pricing_url: source.pricingUrl || source.pricingEndpointUrl,
    status: status === "failed" ? "unknown" : "active",
    source_type: "manual_collected",
    commercial_relation: "none",
    summary: source.summary || "公开价格接口可读取，已进入 PriceAI API 中转站自动价格采集池；稳定性和扣费检测仍需测试 Key 或人工样本补充。",
    channel_types: source.channelTypes || ["undisclosed"],
    account_pools: source.accountPools || ["undisclosed"],
    payment_methods: source.paymentMethods || [],
    minimum_top_up: source.minimumTopUp || null,
    balance_expiry: source.balanceExpiry || null,
    support_channels: source.supportChannels || [],
    refund_policy: source.refundPolicy || null,
    risk_labels: status === "success" ? ["insufficient_samples"] : ["insufficient_samples", "pending_feedback"],
    usage_advice: status === "success" ? "try_small" : "pending",
    data_status: "pending_review",
    availability_seven_day_rate: null,
    availability_seven_day_samples: 0,
    availability_last_checked_at: null,
    availability_note: "已抓取公开价格，尚未接入 API Key 可用性检测。",
    feedback_pending_count: 0,
    feedback_verified_risk_count: 0,
    feedback_merchant_responded_count: 0,
    feedback_main_themes: [],
    feedback_public_notes: collection.error || null,
    collector_kind: source.collectorKind || "new_api_pricing",
    pricing_endpoint_url: source.pricingEndpointUrl,
    collection_status: status,
    collection_error: collection.error || null,
    last_collected_at: collectedAt,
    last_updated_at: collectedAt,
    published: false,
    admin_note: collection.offerCount ? `自动抓取到 ${collection.offerCount} 条 MVP 模型价格，待人工审核。` : "自动抓取未识别到 MVP 模型，待人工确认。",
  };
}

function buildOfferRow(source, item, group, standard, collectedAt) {
  const family = standard.startsWith("Claude") ? "claude" : "gpt";
  const groupMultiplier = group.groupRatio ?? 1;
  const splitMultipliers = getSplitMultipliers(item, group, standard, groupMultiplier);
  if (!splitMultipliers || splitMultipliers.model === null || splitMultipliers.model <= 0) return null;

  return {
    id: stableId("api-transit-offer", source.id, standard, group.key),
    station_id: source.id,
    family,
    standard_model: standard,
    raw_model_name: String(item.model_name || item.name || ""),
    group_name: group.name || group.key || "default",
    recharge_ratio: source.rechargeRatio || DEFAULT_RECHARGE_RATIO,
    model_multiplier: round(splitMultipliers.model, 6),
    input_price: splitMultipliers.input === null ? null : round(splitMultipliers.input, 6),
    output_price: splitMultipliers.output === null ? null : round(splitMultipliers.output, 6),
    cache_read_price: splitMultipliers.cacheRead === null ? null : round(splitMultipliers.cacheRead, 6),
    cache_write_price: splitMultipliers.cacheWrite === null ? null : round(splitMultipliers.cacheWrite, 6),
    currency: "CNY",
    account_pool: inferAccountPool(`${group.name} ${item.model_name || ""}`),
    channel_type: inferChannelType(`${group.name} ${group.description || ""}`),
    price_source: "公开 /api/pricing",
    source_url: source.pricingEndpointUrl,
    availability_seven_day_rate: null,
    availability_seven_day_samples: 0,
    availability_last_checked_at: null,
    availability_note: "价格已抓取，尚未运行 API 可用性检测。",
    last_verified_at: collectedAt,
    status: "needs_review",
    raw_payload: {
      model: item,
      group,
      unit_prices_usd: splitMultipliers.unitPricesUsd || null,
      multiplier_basis: splitMultipliers.basis || "unknown",
    },
  };
}

function getSplitMultipliers(item, group, standard, groupMultiplier) {
  const official = officialTransitPrices[standard];
  const billing = parseBillingExpression(item?.billing_expr);
  if (billing && official) {
    const input = ratioValue(billing.input, official.input, groupMultiplier);
    const output = ratioValue(billing.output, official.output, groupMultiplier);
    const cacheRead = ratioValue(billing.cacheRead, official.cacheRead, groupMultiplier);
    const cacheWrite = ratioValue(billing.cacheWrite, official.cacheWrite, groupMultiplier);
    return {
      model: input ?? output ?? cacheRead ?? cacheWrite,
      input,
      output,
      cacheRead,
      cacheWrite,
    };
  }

  const modelRatio = group.modelRatio;
  if (modelRatio === null || modelRatio <= 0) return null;

  const unitPricesUsd = getNewApiUnitPricesUsd(group, groupMultiplier);
  if (official && unitPricesUsd.input !== null) {
    const input = unitRatioValue(unitPricesUsd.input, official.input);
    const output = unitRatioValue(unitPricesUsd.output, official.output);
    const cacheRead = unitRatioValue(unitPricesUsd.cacheRead, official.cacheRead);
    const cacheWrite = unitRatioValue(unitPricesUsd.cacheWrite, official.cacheWrite);
    return {
      model: input ?? output ?? cacheRead ?? cacheWrite,
      input,
      output,
      cacheRead,
      cacheWrite,
      unitPricesUsd,
      basis: "new_api_usd_per_million",
    };
  }

  const input = modelRatio * groupMultiplier;
  return {
    model: input,
    input,
    output: group.completionRatio === null ? null : input * group.completionRatio,
    cacheRead: group.cacheRatio === null ? null : input * group.cacheRatio,
    cacheWrite: group.createCacheRatio === null ? null : input * group.createCacheRatio,
    unitPricesUsd: null,
    basis: "legacy_multiplier",
  };
}

function ratioValue(value, officialValue, groupMultiplier) {
  if (value === null || officialValue === null || officialValue <= 0) return null;
  return (value * groupMultiplier) / officialValue;
}

function unitRatioValue(value, officialValue) {
  if (value === null || officialValue === null || officialValue <= 0) return null;
  return value / officialValue;
}

function getNewApiUnitPricesUsd(group, groupMultiplier) {
  const input = group.modelRatio * NEW_API_USD_UNIT_PRICE_FACTOR * groupMultiplier;
  return {
    input,
    output: group.completionRatio === null ? null : input * group.completionRatio,
    cacheRead: group.cacheRatio === null ? null : input * group.cacheRatio,
    cacheWrite: group.createCacheRatio === null ? null : input * group.createCacheRatio,
  };
}

function parseBillingExpression(value) {
  const text = String(value || "");
  if (!text) return null;

  const parsed = {
    input: extractBillingTerm(text, "p"),
    output: extractBillingTerm(text, "c"),
    cacheRead: extractBillingTerm(text, "cr"),
    cacheWrite: extractBillingTerm(text, "cc"),
    cacheWriteOneHour: extractBillingTerm(text, "cc1h"),
  };

  return Object.values(parsed).some((item) => item !== null) ? parsed : null;
}

function extractBillingTerm(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}\\s*\\*\\s*(\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : null;
}

function dedupeBestOffers(offers) {
  const byKey = new Map();
  for (const offer of offers) {
    const key = `${offer.station_id}|${offer.standard_model}|${offer.group_name}`;
    const existing = byKey.get(key);
    if (!existing || nullableSortValue(offer.model_multiplier) < nullableSortValue(existing.model_multiplier)) {
      byKey.set(key, offer);
    }
  }

  return Array.from(byKey.values()).sort((a, b) =>
    a.station_id.localeCompare(b.station_id) ||
    a.standard_model.localeCompare(b.standard_model) ||
    nullableSortValue(a.model_multiplier) - nullableSortValue(b.model_multiplier)
  );
}

function standardizeModelName(name) {
  const value = String(name || "").toLowerCase();
  if (!value) return null;

  if (value.includes("claude") && value.includes("sonnet")) {
    if (matchesVersion(value, "4.6") || value.includes("4-6")) return "Claude Sonnet 4.6";
    return null;
  }
  if (value.includes("claude") && value.includes("opus")) {
    if (matchesVersion(value, "4.8") || value.includes("4-8")) return "Claude Opus 4.8";
    if (matchesVersion(value, "4.7") || value.includes("4-7")) return "Claude Opus 4.7";
    if (matchesVersion(value, "4.6") || value.includes("4-6")) return "Claude Opus 4.6";
    return null;
  }

  if (value.includes("gpt") || value.includes("codex") || value.includes("openai")) {
    if (matchesVersion(value, "5.5") || value.includes("5-5")) return "GPT 5.5";
    if (/\bgpt[-._ ]?5[-._ ]?4[-._ ]?mini\b/.test(value)) return null;
    if (matchesVersion(value, "5.4") || value.includes("5-4")) return "GPT 5.4";
  }

  return null;
}

function matchesVersion(value, version) {
  const escaped = version.replace(".", "[.-]");
  return new RegExp(`(^|[^0-9])${escaped}([^0-9]|$)`).test(value);
}

function inferAccountPool(text) {
  const value = String(text || "").toLowerCase();
  if (value.includes("official") || value.includes("官方") || value.includes("官转") || value.includes("官key")) return "official_api";
  if (value.includes("max")) return "max";
  if (value.includes("team")) return "team";
  if (value.includes("plus")) return "plus";
  if (value.includes("pro")) return "pro";
  if (value.includes("mixed") || value.includes("混")) return "mixed";
  return "undisclosed";
}

function inferChannelType(text) {
  const value = String(text || "").toLowerCase();
  if (value.includes("official") || value.includes("官方") || value.includes("官转") || value.includes("官key")) return "official_api";
  if (value.includes("aws") || value.includes("azure") || value.includes("vertex") || value.includes("云")) return "cloud";
  if (value.includes("混")) return "mixed";
  if (value.includes("分销") || value.includes("reseller")) return "reseller";
  return "undisclosed";
}

async function postRows(rows, options) {
  const plan = {
    dryRun: Boolean(options.dryRun),
    stations: rows.stations.length,
    offers: rows.offers.length,
    runs: rows.runs.length,
    publish: Boolean(options.publish),
  };

  if (options.dryRun) {
    return {
      ...plan,
      skipped: true,
      message: "--dry-run --post 只验证将要写入的 API 中转数据，不连接 Supabase。",
    };
  }

  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for --post/--db.");

  const existingStations = await readExistingStations(supabase, rows.stations.map((station) => station.id));
  const stations = rows.stations.map((station) => mergeStationForRefresh(station, existingStations.get(station.id), options));
  const existingOffers = await readExistingOffers(supabase, rows.offers.map((offer) => offer.id));
  const offers = rows.offers.map((offer) => mergeOfferForRefresh(offer, existingOffers.get(offer.id), options));

  await upsertRows(supabase, "api_transit_stations", stations, { onConflict: "id" });
  await upsertRows(supabase, "api_transit_offers", offers, { onConflict: "id" });
  await upsertRows(supabase, "api_transit_detection_runs", rows.runs, { onConflict: "id" });

  return {
    ...plan,
    skipped: false,
    message: options.publish ? "API 中转公开价格已写入并发布。" : "API 中转公开价格已写入待审核队列。",
  };
}

async function readExistingOffers(supabase, offerIds) {
  const ids = uniqueText(offerIds).filter(Boolean);
  const byId = new Map();
  for (const chunk of chunks(ids, 300)) {
    if (!chunk.length) continue;
    const { data, error } = await supabase
      .from("api_transit_offers")
      .select("id,status,created_at")
      .in("id", chunk);
    if (error) throw error;
    for (const row of data || []) byId.set(row.id, row);
  }
  return byId;
}

function mergeOfferForRefresh(offer, existing, options) {
  return {
    ...offer,
    status: options.publish ? "active" : existing?.status || offer.status,
    created_at: existing?.created_at || offer.created_at,
  };
}

async function readExistingStations(supabase, stationIds) {
  const ids = uniqueText(stationIds).filter(Boolean);
  const byId = new Map();
  for (const chunk of chunks(ids, 300)) {
    if (!chunk.length) continue;
    const { data, error } = await supabase
      .from("api_transit_stations")
      .select(
        [
          "id",
          "source_type",
          "commercial_relation",
          "summary",
          "payment_methods",
          "minimum_top_up",
          "balance_expiry",
          "support_channels",
          "refund_policy",
          "data_status",
          "commercial_offers",
          "verification_events",
          "published",
          "admin_note",
          "created_at",
        ].join(","),
      )
      .in("id", chunk);
    if (error) throw error;
    for (const row of data || []) byId.set(row.id, row);
  }
  return byId;
}

function mergeStationForRefresh(station, existing, options) {
  if (!existing) {
    return {
      ...station,
      published: Boolean(options.publish),
      data_status: options.publish ? "verified" : station.data_status,
    };
  }

  return {
    ...station,
    source_type: existing.source_type || station.source_type,
    commercial_relation: existing.commercial_relation || station.commercial_relation,
    summary: existing.summary || station.summary,
    payment_methods: Array.isArray(existing.payment_methods) ? existing.payment_methods : station.payment_methods,
    minimum_top_up: existing.minimum_top_up ?? station.minimum_top_up,
    balance_expiry: existing.balance_expiry ?? station.balance_expiry,
    support_channels: Array.isArray(existing.support_channels) ? existing.support_channels : station.support_channels,
    refund_policy: existing.refund_policy ?? station.refund_policy,
    data_status: options.publish ? "verified" : existing.data_status || station.data_status,
    commercial_offers: existing.commercial_offers ?? station.commercial_offers,
    verification_events: existing.verification_events ?? station.verification_events,
    published: options.publish ? true : Boolean(existing.published),
    admin_note: existing.admin_note || station.admin_note,
    created_at: existing.created_at || station.created_at,
  };
}

async function upsertRows(supabase, table, rows, options = {}) {
  for (const chunk of chunks(rows, 300)) {
    if (!chunk.length) continue;
    const { error } = await supabase.from(table).upsert(chunk, options);
    if (error) {
      error.table = table;
      throw error;
    }
  }
}

function loadSources() {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function selectSources(sources, options) {
  const ids = optionList(options.source || options.sources);
  const selected = ids.length ? sources.filter((source) => ids.includes(source.id)) : sources;
  if (!selected.length) throw new Error("No API transit sources matched.");
  return selected;
}

function compactSnapshot(payload) {
  const text = JSON.stringify(payload);
  if (text.length <= 100000) return payload;
  return {
    truncated: true,
    keys: payload && typeof payload === "object" ? Object.keys(payload) : [],
    bytes: text.length,
  };
}

function getSupabaseClient() {
  const env = readEnvFile(path.join(repoRoot, ".env.local"));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function readEnvFile(filePath) {
  const output = {};
  if (!existsSync(filePath)) return output;

  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    output[match[1]] = unquote(match[2].trim());
  }
  return output;
}

function unquote(value) {
  const quote = value[0];
  if ((quote === `"` || quote === `'`) && value[value.length - 1] === quote) {
    return value.slice(1, -1);
  }
  return value;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith("--")) continue;
    const rawKey = item.slice(2);
    const [key, inlineValue] = rawKey.split("=", 2);
    const next = values[index + 1];

    if (inlineValue !== undefined) {
      result[key] = inlineValue;
    } else if (!next || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function normalizeOptions(options) {
  return {
    ...options,
    dryRun: truthyOption(options.dryRun ?? options["dry-run"]),
    post: truthyOption(options.post),
    db: truthyOption(options.db),
    publish: truthyOption(options.publish),
  };
}

function truthyOption(value) {
  return value === true || value === "true" || value === "1" || value === "";
}

function optionList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(optionList);
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function uniqueText(values) {
  return Array.from(
    new Set(
      (values || [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

function numberValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function round(value, digits) {
  const base = 10 ** digits;
  return Math.round(value * base) / base;
}

function nullableSortValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function chunks(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

function stableId(...parts) {
  const input = parts.filter((part) => part !== null && part !== undefined).join("|");
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) hash = (hash * 33) ^ input.charCodeAt(index);
  return `id-${(hash >>> 0).toString(36)}`;
}

function printSummary(result) {
  console.log(
    [
      "API transit collect plan.",
      `sources=${result.counts.sources}`,
      `stations=${result.counts.stations}`,
      `offers=${result.counts.offers}`,
      `runs=${result.counts.runs}`,
      result.database ? `database=${result.database.skipped ? "dry-run" : "posted"}` : "database=not-requested",
      result.publish ? "publish=true" : "publish=false",
    ].join(" "),
  );
}

function isCli() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function errorMessage(error) {
  if (error?.name === "AbortError") return "请求超时。";
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") return JSON.stringify(error, null, 2);
  return String(error);
}
