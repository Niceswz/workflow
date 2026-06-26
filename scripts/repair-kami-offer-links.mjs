#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";
import collectorRegistry from "../config/collectors.json" with { type: "json" };

const KAMI_HOSTS = collectorHostsForKind("kami");

const APPLY = process.argv.includes("--apply");
const PAGE_SIZE = 1000;
const UPDATE_CONCURRENCY = 12;

function collectorHostsForKind(kind) {
  return new Set(
    (collectorRegistry.kinds.find((entry) => entry.kind === kind)?.hosts || [])
      .map((host) => normalizeHostname(host)),
  );
}

async function main() {
  const supabase = getSupabaseClient();
  const rows = await listCommodityOfferRows(supabase);
  const candidates = rows
    .map((row) => ({ row, nextUrl: toKamiItemUrl(row.url) }))
    .filter((item) => item.nextUrl && item.nextUrl !== item.row.url);

  const byHost = groupByHost(candidates);
  console.table(
    [...byHost.entries()]
      .map(([host, count]) => ({ host, count }))
      .sort((a, b) => b.count - a.count),
  );

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? "apply" : "dry-run",
        scanned: rows.length,
        candidates: candidates.length,
        sample: candidates.slice(0, 8).map(({ row, nextUrl }) => ({
          id: row.id,
          source: row.source_name,
          title: row.source_title,
          from: row.url,
          to: nextUrl,
        })),
      },
      null,
      2,
    ),
  );

  if (!APPLY || !candidates.length) return;

  const updatedAt = new Date().toISOString();

  const results = await mapWithConcurrency(candidates, UPDATE_CONCURRENCY, async ({ row, nextUrl }) => {
    const { count, error } = await supabase
      .from("raw_offers")
      .update({ url: nextUrl, updated_at: updatedAt }, { count: "exact" })
      .eq("id", row.id)
      .eq("url", row.url);
    if (error) throw error;

    const { count: feedbackCount, error: feedbackError } = await supabase
      .from("offer_feedback")
      .update({ offer_url: nextUrl }, { count: "exact" })
      .eq("offer_url", row.url);
    if (feedbackError) throw feedbackError;
    return {
      updatedOffers: count || 0,
      updatedFeedback: feedbackCount || 0,
    };
  });

  const updatedOffers = results.reduce((sum, result) => sum + result.updatedOffers, 0);
  const updatedFeedback = results.reduce((sum, result) => sum + result.updatedFeedback, 0);

  console.log(JSON.stringify({ updatedOffers, updatedFeedback }, null, 2));
}

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

async function listCommodityOfferRows(supabase) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("raw_offers")
      .select("id,source_name,source_store_name,source_title,url")
      .ilike("url", "%?commodity=%")
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

function toKamiItemUrl(value) {
  try {
    const parsed = new URL(value);
    const commodityId = parsed.searchParams.get("commodity");
    if (!commodityId) return null;
    if (!KAMI_HOSTS.has(normalizeHostname(parsed.hostname))) return null;

    parsed.pathname = `/item/${encodeURIComponent(commodityId)}`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeHostname(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}

function groupByHost(items) {
  const output = new Map();
  for (const { nextUrl } of items) {
    const host = new URL(nextUrl).host;
    output.set(host, (output.get(host) || 0) + 1);
  }
  return output;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runNext() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runNext()),
  );
  return results;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
