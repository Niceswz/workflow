#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const failures = [];

const routeFilesWithPriceCache = [
  "src/app/api/explorer/route.ts",
  "src/app/api/offers/route.ts",
  "src/app/api/products/[id]/offers/route.ts",
];

const publicDataModules = [
  {
    file: "src/lib/data.ts",
    timeoutPattern: /PUBLIC_SUPABASE_READ_TIMEOUT_MS\s*=\s*2_500/,
    abortPattern: /abortSignal\(publicSupabaseReadSignal\(\)\)/,
    label: "public offer reads",
  },
  {
    file: "src/lib/api-transit-db.ts",
    timeoutPattern: /PUBLIC_TRANSIT_READ_TIMEOUT_MS\s*=\s*2_500/,
    abortPattern: /abortSignal\(signal\)/,
    label: "API transit public reads",
  },
  {
    file: "src/lib/api-models-db.ts",
    timeoutPattern: /PUBLIC_API_MODEL_READ_TIMEOUT_MS\s*=\s*2_500/,
    abortPattern: /abortSignal\(signal\)/,
    label: "API model public reads",
  },
  {
    file: "src/lib/official-prices-db.ts",
    timeoutPattern: /PUBLIC_OFFICIAL_PRICE_READ_TIMEOUT_MS\s*=\s*2_500/,
    abortPattern: /abortSignal\(signal\)/,
    label: "official price public reads",
  },
];

for (const dataModule of publicDataModules) {
  const text = read(dataModule.file);
  assert(dataModule.timeoutPattern.test(text), `${dataModule.file}: ${dataModule.label} must keep a short 2.5s runtime timeout.`);
  assert(dataModule.abortPattern.test(text), `${dataModule.file}: ${dataModule.label} must pass an AbortSignal to Supabase reads.`);
}

for (const routeFile of routeFilesWithPriceCache) {
  const text = read(routeFile);
  assert(/priceDataCacheHeaders/.test(text), `${routeFile}: public price API must use shared CDN cache headers.`);
  assert(!/no-store/i.test(text), `${routeFile}: public price API must not use no-store caching.`);
}

const dataText = read("src/lib/data.ts");
assert(/PUBLIC_FALLBACK_MAX_ROWS\s*=\s*5000/.test(dataText), "src/lib/data.ts: public raw_offers fallback must keep a hard row cap.");
assert(/for\s*\(\s*let\s+from\s*=\s*0;\s*from\s*<\s*PUBLIC_FALLBACK_MAX_ROWS/.test(dataText), "src/lib/data.ts: public raw_offers fallback must be bounded by PUBLIC_FALLBACK_MAX_ROWS.");
assert(!/PUBLIC_OFFER_LIMIT\s*=\s*1200/.test(dataText), "src/lib/data.ts: public offer APIs must not allow 1200-row public pages.");
assert(/PUBLIC_DATA_CACHE_TTL_MS\s*=\s*PRICE_DATA_CACHE_TTL_MS/.test(dataText), "src/lib/data.ts: public data in-memory TTL must use the shared price cache policy.");
assert(/EXPLORER_DATA_CACHE_TTL_MS\s*=\s*PRICE_DATA_CACHE_TTL_MS/.test(dataText), "src/lib/data.ts: explorer data TTL must use the shared price cache policy.");
assert(/PRODUCT_OFFERS_CACHE_TTL_MS\s*=\s*PRICE_DATA_CACHE_TTL_MS/.test(dataText), "src/lib/data.ts: product offer TTL must use the shared price cache policy.");
assert(/filterFacetsPromise\.catch/.test(dataText), "src/lib/data.ts: auxiliary product offer facets must not be allowed to fail the primary offer page.");

const publicCachePolicyText = read("src/lib/public-cache-policy.ts");
assert(/PRICE_DATA_EDGE_SECONDS\s*=\s*300/.test(publicCachePolicyText), "src/lib/public-cache-policy.ts: price data edge TTL must stay at 300s unless the cost plan is updated.");
assert(/PRICE_DATA_STALE_SECONDS\s*=\s*1800/.test(publicCachePolicyText), "src/lib/public-cache-policy.ts: price data stale window must stay at 1800s unless the cost plan is updated.");
assert(/PRICE_DATA_CACHE_TTL_MS\s*=\s*PRICE_DATA_EDGE_SECONDS\s*\*\s*1000/.test(publicCachePolicyText), "src/lib/public-cache-policy.ts: client/server TTL must derive from the shared edge TTL.");

const priceExplorerText = read("src/components/PriceExplorer.tsx");
assert(/EXPLORER_CACHE_TTL_MS\s*=\s*PRICE_DATA_CACHE_TTL_MS/.test(priceExplorerText), "src/components/PriceExplorer.tsx: explorer client cache must use the shared price cache policy.");
assert(/OFFER_LIST_CACHE_TTL_MS\s*=\s*PRICE_DATA_CACHE_TTL_MS/.test(priceExplorerText), "src/components/PriceExplorer.tsx: offer list client cache must use the shared price cache policy.");

const productOffersPanelText = read("src/components/ProductOffersPanel.tsx");
assert(/PRODUCT_OFFERS_CACHE_TTL_MS\s*=\s*PRICE_DATA_CACHE_TTL_MS/.test(productOffersPanelText), "src/components/ProductOffersPanel.tsx: product offer client cache must use the shared price cache policy.");

const publicOfferQueryText = read("src/lib/public-offer-query.ts");
assert(/PUBLIC_OFFER_MAX_LIMIT\s*=\s*200/.test(publicOfferQueryText), "src/lib/public-offer-query.ts: public offer pages must stay capped at 200 rows or less.");
assert(/PUBLIC_OFFER_MAX_OFFSET\s*=\s*5000/.test(publicOfferQueryText), "src/lib/public-offer-query.ts: public offer offset must keep a bounded public scan window.");

const transitPublicText = read("src/lib/api-transit-db.ts");
assert(!/api_transit_detection_runs/.test(transitPublicText), "src/lib/api-transit-db.ts: public API transit reads must not query detection runs.");
assert(!/raw_snapshot/.test(transitPublicText), "src/lib/api-transit-db.ts: public API transit reads must not parse raw snapshots.");

const transitAdminText = read("src/lib/api-transit-admin.ts");
assert(/ADMIN_RUN_SELECT/.test(transitAdminText), "src/lib/api-transit-admin.ts: admin run lists must use an explicit field projection.");
assert(!/select\(\s*["'`]\*,\s*api_transit_stations\(name\)["'`]\s*\)/.test(transitAdminText), "src/lib/api-transit-admin.ts: admin run lists must not select raw snapshots with *.");
assert(/ADMIN_LATEST_RUN_SCAN_LIMIT/.test(transitAdminText), "src/lib/api-transit-admin.ts: latest-run lookup must keep a bounded scan limit.");

const probeText = read("scripts/probe-api-transit.mjs");
assert(/api_transit_availability_samples/.test(probeText), "scripts/probe-api-transit.mjs: availability rollup must use structured sample rows.");
assert(
  !/\.from\(\s*["'`]api_transit_detection_runs["'`]\s*\)[\s\S]{0,500}\.select\([\s\S]{0,120}raw_snapshot/.test(probeText),
  "scripts/probe-api-transit.mjs: availability rollup must not read historical raw snapshots.",
);
assert(/AVAILABILITY_SAMPLE_LOOKBACK_LIMIT\s*=\s*2000/.test(probeText), "scripts/probe-api-transit.mjs: structured availability sample lookup must stay bounded.");

const transitSamplesMigration = read("supabase/migrations/20260618134500_api_transit_availability_samples.sql");
assert(/create table if not exists api_transit_availability_samples/.test(transitSamplesMigration), "api transit availability sample migration must create the structured sample table.");
assert(/checked_at desc/.test(transitSamplesMigration), "api transit availability sample migration must index station time lookups.");

const smokeText = read("scripts/smoke-cloudflare.mjs");
assert(/SMOKE_FETCH_TIMEOUT_MS/.test(smokeText), "scripts/smoke-cloudflare.mjs: smoke checks must have a request timeout.");
assert(/fetchWithTimeout/.test(smokeText), "scripts/smoke-cloudflare.mjs: smoke checks must use fetchWithTimeout.");

const packageText = read("package.json");
assert(/"check:performance"\s*:\s*"node scripts\/check-performance-guards\.mjs"/.test(packageText), "package.json: add npm run check:performance.");

const buildCloudflareText = read("scripts/build-cloudflare.mjs");
assert(/check-performance-guards\.mjs/.test(buildCloudflareText), "scripts/build-cloudflare.mjs: run performance guards before OpenNext build.");

const qualityWorkflowText = read(".github/workflows/quality.yml");
assert(/npm run check:performance/.test(qualityWorkflowText), ".github/workflows/quality.yml: run performance guards before build.");

for (const file of listSourceFiles(["src/app", "src/lib"])) {
  if (!isPublicRuntimeFile(file)) continue;
  const text = read(file);
  if (/api_transit_detection_runs|raw_snapshot/.test(text)) {
    failures.push(`${file}: public runtime code must not read API transit raw detection snapshots.`);
  }
}

if (failures.length) {
  console.error("Performance guard failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Performance guard passed.");

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function read(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    failures.push(`${relativePath}: file is missing.`);
    return "";
  }
  return readFileSync(absolutePath, "utf8");
}

function listSourceFiles(roots) {
  const files = [];
  for (const root of roots) walk(path.join(repoRoot, root), files);
  return files.map((file) => path.relative(repoRoot, file).split(path.sep).join("/"));
}

function walk(directory, files) {
  for (const entry of readdirSync(directory)) {
    const absolutePath = path.join(directory, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      walk(absolutePath, files);
      continue;
    }
    if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) files.push(absolutePath);
  }
}

function isPublicRuntimeFile(file) {
  if (file.includes("/admin/") || file.includes("/api/admin/") || file.includes("/api/cron/")) return false;
  if (file.endsWith("api-transit-admin.ts")) return false;
  if (file.endsWith("official-price-jobs.ts")) return false;
  return true;
}
