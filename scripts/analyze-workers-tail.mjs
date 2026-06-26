#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const args = parseArgs(process.argv.slice(2));
const input = args.file || args.f || args._[0];
const top = boundedNumber(args.top || 20, 1, 100, 20);
const jsonOutput = Boolean(args.json);

if (!input) {
  console.error("Usage: node scripts/analyze-workers-tail.mjs --file /path/to/wrangler-tail.jsonl [--top 20] [--json]");
  process.exit(1);
}

if (!existsSync(input)) {
  console.error(`Tail file not found: ${input}`);
  process.exit(1);
}

const text = readFileSync(input, "utf8");
const events = parseTailEvents(text);
const report = buildReport(events, { input, top });

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printReport(report);
}

function buildReport(events, meta) {
  const rows = events
    .map(eventToRow)
    .filter((row) => row.url);
  const byClass = aggregate(rows, (row) => row.classification);
  const byPath = aggregate(rows, (row) => row.path);
  const byClient = aggregate(rows, (row) => row.clientKey);
  const byMethodClass = aggregate(rows, (row) => `${row.method} ${row.classification}`);

  const totalCpuMs = rows.reduce((sum, row) => sum + row.cpuMs, 0);
  const totalWallMs = rows.reduce((sum, row) => sum + row.wallMs, 0);
  const start = rows.reduce((min, row) => Math.min(min, row.timestamp || min), Number.POSITIVE_INFINITY);
  const end = rows.reduce((max, row) => Math.max(max, row.timestamp || max), 0);

  return {
    meta: {
      ...meta,
      events: rows.length,
      start: Number.isFinite(start) ? new Date(start).toISOString() : null,
      end: end ? new Date(end).toISOString() : null,
      durationSeconds: end && Number.isFinite(start) ? Number(((end - start) / 1000).toFixed(1)) : null,
    },
    summary: {
      totalCpuMs,
      totalWallMs,
      avgCpuMs: average(rows.map((row) => row.cpuMs)),
      avgWallMs: average(rows.map((row) => row.wallMs)),
      nonOkOutcomes: rows.filter((row) => row.outcome !== "ok").length,
      truncated: rows.filter((row) => row.truncated).length,
    },
    byClass: byClass.slice(0, top),
    topPathsByCpu: byPath.slice(0, top),
    topClientsByCpu: byClient.slice(0, top),
    topMethodClassesByCpu: byMethodClass.slice(0, top),
  };
}

function eventToRow(event) {
  const request = event.event?.request || {};
  const url = request.url || "";
  const parsedUrl = safeUrl(url);
  const headers = request.headers || {};
  const cf = request.cf || {};
  const classification = classifyRequest(parsedUrl, headers);
  const clientIp = headers["cf-connecting-ip"] || headers["x-real-ip"] || "";
  const asn = cf.asOrganization || "unknown ASN";
  const country = headers["cf-ipcountry"] || cf.country || "?";

  return {
    url,
    path: parsedUrl?.pathname || "(unknown)",
    query: parsedUrl?.search || "",
    method: request.method || "GET",
    classification,
    cpuMs: Number(event.cpuTime || 0),
    wallMs: Number(event.wallTime || 0),
    outcome: event.outcome || "unknown",
    truncated: Boolean(event.truncated),
    timestamp: Number(event.eventTimestamp || 0),
    clientKey: `${hashClient(clientIp)} ${country} ${asn} ${bucketUserAgent(headers["user-agent"] || "")}`,
  };
}

function classifyRequest(url, headers) {
  if (!url) return "unknown";
  if (url.pathname.startsWith("/api/")) return "api";
  if (url.searchParams.has("_rsc") || headers.rsc === "1") return "rsc";
  if (url.pathname.startsWith("/_next/") || /\.[a-z0-9]{2,8}$/i.test(url.pathname)) return "asset";
  return "page";
}

function aggregate(rows, keyForRow) {
  const map = new Map();

  for (const row of rows) {
    const key = String(keyForRow(row) || "unknown");
    const entry = map.get(key) || {
      key,
      requests: 0,
      cpuMs: 0,
      wallMs: 0,
      maxCpuMs: 0,
      cpuValues: [],
      examples: new Set(),
    };

    entry.requests += 1;
    entry.cpuMs += row.cpuMs;
    entry.wallMs += row.wallMs;
    entry.maxCpuMs = Math.max(entry.maxCpuMs, row.cpuMs);
    entry.cpuValues.push(row.cpuMs);
    if (entry.examples.size < 3) {
      entry.examples.add(row.query ? `${row.path}${redactQuery(row.query)}` : row.path);
    }
    map.set(key, entry);
  }

  return [...map.values()]
    .map((entry) => ({
      key: entry.key,
      requests: entry.requests,
      cpuMs: entry.cpuMs,
      avgCpuMs: average(entry.cpuValues),
      p95CpuMs: percentile(entry.cpuValues, 0.95),
      maxCpuMs: entry.maxCpuMs,
      wallMs: entry.wallMs,
      avgWallMs: averageValue(entry.wallMs, entry.requests),
      examples: [...entry.examples],
    }))
    .sort((a, b) => b.cpuMs - a.cpuMs);
}

function parseTailEvents(text) {
  const parsed = [];
  for (const chunk of splitJsonObjects(text)) {
    try {
      parsed.push(JSON.parse(chunk));
    } catch {
      // Ignore partial lines from interrupted tail sessions.
    }
  }
  return parsed;
}

function splitJsonObjects(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function printReport(report) {
  console.log(`Workers tail analysis: ${report.meta.input}`);
  console.log(`Events: ${report.meta.events}, window: ${report.meta.start || "unknown"} -> ${report.meta.end || "unknown"}`);
  console.log("\nSummary");
  console.table([report.summary]);
  console.log("\nBy request class");
  console.table(report.byClass.map(compactRow));
  console.log("\nTop paths by CPU");
  console.table(report.topPathsByCpu.map(compactRow));
  console.log("\nTop method/classes by CPU");
  console.table(report.topMethodClassesByCpu.map(compactRow));
  console.log("\nTop clients by CPU");
  console.table(report.topClientsByCpu.map((row) => ({
    ...compactRow(row),
    key: row.key.slice(0, 110),
  })));
}

function compactRow(row) {
  return {
    key: row.key,
    requests: row.requests,
    cpuMs: row.cpuMs,
    avgCpuMs: row.avgCpuMs,
    p95CpuMs: row.p95CpuMs,
    maxCpuMs: row.maxCpuMs,
    avgWallMs: row.avgWallMs,
    examples: row.examples.join(" | ").slice(0, 180),
  };
}

function redactQuery(query) {
  const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  if (params.has("_rsc")) return "?_rsc=...";
  if (!params.size) return "";
  return `?${[...params.keys()].slice(0, 4).join("&")}`;
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function bucketUserAgent(userAgent) {
  const normalized = userAgent.toLowerCase();
  if (/bot|spider|crawler|slurp|dotbot|chatgpt-user/.test(normalized)) return userAgent.slice(0, 90);
  if (normalized.includes("chrome")) return "Chrome-like browser";
  if (normalized.includes("safari")) return "Safari-like browser";
  return userAgent.slice(0, 90) || "(empty UA)";
}

function hashClient(value) {
  if (!value) return "unknown-client";
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function average(values) {
  if (!values.length) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function averageValue(total, count) {
  if (!count) return 0;
  return Number((total / count).toFixed(2));
}

function percentile(values, percentileValue) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index] || 0;
}

function boundedNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}
