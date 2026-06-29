/**
 * PriceAI 采集数据接收接口（轻量版）
 *
 * 替代 priceai.cc 网站的 /api/admin/crawl-log 和 /api/admin/collector-heartbeat 接口。
 * 部署到 Cloudflare Workers。
 *
 * 部署方式：
 *   wrangler deploy scripts/crawl-log-worker.mjs --name priceai-crawl-log
 *
 * 需要配置的环境变量（通过 wrangler secret put 设置）：
 *   NEXT_PUBLIC_SUPABASE_URL - Supabase 项目地址
 *   SUPABASE_SERVICE_ROLE_KEY - Supabase service_role key
 *   ADMIN_PASSWORD - 与 CRON_SECRET 保持一致，用于验证采集器身份
 */

import { createClient } from "@supabase/supabase-js";

// ── 配置 ──────────────────────────────────────────────────────────────
const SUPABASE_URL = "";
const SUPABASE_KEY = "";
const ADMIN_PASSWORD = "";

// ── Offer ID 生成（与 collect-prices.mjs 的 stableOfferInputId 保持一致） ──
// 采集器发送的 offer 没有 id 字段，ID 由服务端根据 offer 内容生成确定性哈希。
// 这样同一商品每次采集的 ID 相同，upsert 会更新而不是重复插入。

// ── 与 collect-prices.mjs 完全一致的 ID 生成算法 ──
// 注意：必须与 PriceAI/scripts/collect-prices.mjs 中的 stableOfferInputId 完全一致
// 否则同一报价会生成不同 ID，导致 upsert 产生重复数据

const SHOP_API_OFFER_HOSTS = new Set([
  "catfk.com",
  "ldxp.cn",
  "pay.ldxp.cn",
  "pay.qxvx.cn",
]);

function stableOfferInputId(offer) {
  const shopItemUrl = normalizeShopApiItemOfferUrl(offer.url);
  if (shopItemUrl) return stableId("shop-api-offer", shopItemUrl);
  return stableId(offer.sourceName, offer.sourceStoreName, offer.sourceTitle, offer.url);
}

function normalizeShopApiItemOfferUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const host = normalizeHostname(parsed.hostname);
    if (!SHOP_API_OFFER_HOSTS.has(host)) return null;
    const pathGoodsKey = (parsed.pathname.match(/^\/item\/([^/?#]+)/i) || [])[1] || null;
    const goodsKey = pathGoodsKey || parsed.searchParams.get("commodity") || parsed.searchParams.get("id");
    if (!goodsKey) return null;
    return `https://${host}/item/${encodeURIComponent(decodeURIComponent(goodsKey))}`;
  } catch {
    return null;
  }
}

function normalizeHostname(hostname) {
  return hostname ? hostname.replace(/^www\./, "").toLowerCase() : "";
}

function stableId(...parts) {
  const input = parts.filter((part) => part !== null && part !== undefined).join("|");
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return "id-" + (hash >>> 0).toString(36);
}

function nowISO() {
  return new Date().toISOString();
}

// ── Cloudflare Workers 入口 ──────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const supabase = createClient(
      env.NEXT_PUBLIC_SUPABASE_URL || SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY,
    );
    const password = env.ADMIN_PASSWORD || ADMIN_PASSWORD;

    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    // 健康检查
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true });
    }

    // ── 采集心跳 ──────────────────────────────────────────────────
    // 采集器发送的 payload 结构：
    // {
    //   node: { id, name, type, runtime, region },
    //   scope: { ... },
    //   status: "running" | "success" | "failed",
    //   startedAt, finishedAt,
    //   successCount, failureCount, skippedCount, offerCount,
    //   message, details: { ... }
    // }
    if (request.method === "POST" && url.pathname === "/api/admin/collector-heartbeat") {
      const body = await request.json();
      const auth = request.headers.get("x-admin-password");
      if (auth !== password) {
        return jsonResponse({ ok: false, message: "No API key found in request" }, 401);
      }

      const node = body.node || {};
      const { error } = await supabase.from("collector_heartbeats").upsert(
        {
          node_id: node.id || "unknown",
          node_name: node.name || "unknown",
          node_type: node.type || null,
          runtime: node.runtime || null,
          region: node.region || null,
          scope: body.scope || null,
          status: body.status || "unknown",
          started_at: body.startedAt || null,
          finished_at: body.finishedAt || null,
          last_seen_at: nowISO(),
          success_count: Number(body.successCount || 0),
          failure_count: Number(body.failureCount || 0),
          skipped_count: Number(body.skippedCount || 0),
          offer_count: Number(body.offerCount || 0),
          message: body.message || null,
          details: body.details || null,
        },
        { onConflict: "node_id" },
      );
      if (error) {
        return jsonResponse({ ok: false, message: error.message }, 500);
      }
      return jsonResponse({ ok: true });
    }

    // ── 采集数据写入 ──────────────────────────────────────────────
    // 采集器发送的 payload 结构（单个或数组）：
    // {
    //   sourceId: "aisou-pro",
    //   sourceName: "Aisou智充",
    //   sourceUrl: "https://aisou.pro/",
    //   mode: "http",
    //   status: "success" | "partial" | "failed",
    //   message: "...",
    //   offers: [
    //     {
    //       sourceId, sourceName, sourceUrl, sourceStoreName,
    //       sourceTitle: "ChatGPT Plus",
    //       price: 68.00,
    //       listedPrice: null,
    //       feeAmount: null,
    //       priceBasis: null,
    //       currency: "CNY",
    //       status: "available" | "out_of_stock",
    //       url: "https://...",
    //       tags: [],
    //       stockCount: null,
    //     }
    //   ],
    //   details: {
    //     collectorNode: { id, name, type, runtime, region },
    //     collector: "kami",
    //     batchIndex: 1,
    //     batchCount: 1,
    //     fullSnapshot: true,
    //     seenOfferIds: [...],
    //   }
    // }
    if (request.method === "POST" && url.pathname === "/api/admin/crawl-log") {
      const body = await request.json();
      const auth = request.headers.get("x-admin-password");
      if (auth !== password) {
        return jsonResponse({ ok: false, message: "No API key found in request" }, 401);
      }

      // 支持单条或批量
      const results = Array.isArray(body) ? body : [body];
      let totalSuccess = 0;
      let totalWritten = 0;

      for (const run of results) {
        const sourceId = run.sourceId || "";
        const sourceName = run.sourceName || "";
        const offers = run.offers || [];
        const status = run.status || "success";
        const collectedAt = nowISO();

        // 写入 raw_offers
        if (offers.length > 0) {
          const rows = offers.map((offer) => ({
            id: offer.id || stableOfferInputId(offer),
            source_id: sourceId,
            source_name: sourceName,
            source_store_name: offer.sourceStoreName || null,
            source_title: offer.sourceTitle || "",
            price: offer.price ?? null,
            listed_price: offer.listedPrice ?? offer.listed_price ?? null,
            fee_amount: offer.feeAmount ?? offer.fee_amount ?? null,
            price_basis: offer.priceBasis ?? null,
            currency: offer.currency || "CNY",
            status: offer.status || "unknown",
            source_status: offer.status || "unknown",
            effective_status: offer.status === "out_of_stock" ? "unavailable" : "available",
            freshness_status: "fresh",
            url: offer.url || "",
            tags: offer.tags || [],
            stock_count: offer.stockCount ?? null,
            hidden: false,
            captured_at: collectedAt,
            last_seen_at: collectedAt,
            verified_at: collectedAt,
          }));

          const { error: insertError } = await supabase
            .from("raw_offers")
            .upsert(rows, { onConflict: "id", ignoreDuplicates: false });

          if (insertError) {
            return jsonResponse({ ok: false, message: insertError.message }, 500);
          }
          totalWritten += offers.length;
        }

        // 写入 crawl_runs
        const runId = run.id || ("run-" + nowISO().replace(/[:.]/g, "-") + "-" + Math.random().toString(36).slice(2, 8));
        const { error: runError } = await supabase
          .from("crawl_runs")
          .upsert({
            id: runId,
            source_id: sourceId,
            source_name: sourceName,
            mode: run.mode || "http",
            status: status,
            started_at: collectedAt,
            finished_at: collectedAt,
            success_count: offers.length,
            failure_count: 0,
            message: run.message || null,
            details: run.details || {},
          }, { onConflict: "id" });

        if (runError) {
          return jsonResponse({ ok: false, message: runError.message }, 500);
        }

        totalSuccess++;
      }

      return jsonResponse({
        ok: true,
        successCount: totalSuccess,
        writtenCount: totalWritten,
        unchangedCount: 0,
        refreshedCount: 0,
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
