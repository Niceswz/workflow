#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { collectApiModels } from "./collect-api-models.mjs";
import { importApiModelDataset } from "./import-api-models.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultOfficialSnapshotPath = path.join(repoRoot, "data", "official-prices", "latest.json");
const defaultReportPath = path.join(repoRoot, "docs", "planning", "p2-closeout-report.md");
const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) PriceAI/1.0";

if (isCli()) {
  const args = normalizeOptions(parseArgs(process.argv.slice(2)));

  try {
    const result = await buildP2CloseoutReport(args);
    printSummary(result);

    if (args.write) {
      const outPath = path.resolve(repoRoot, args.out || defaultReportPath);
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, renderMarkdownReport(result), "utf8");
      console.log(`P2 closeout report written to ${path.relative(repoRoot, outPath)}`);
    }

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
}

export async function buildP2CloseoutReport(options = {}) {
  const data = await loadApiModelModule();
  const officialSnapshot = await readOptionalJson(options.officialSnapshot || defaultOfficialSnapshotPath);
  const candidateProbes = options.noFetch
    ? []
    : await probeCandidateUrls(data.apiProviderCandidates, {
      timeoutMs: Number(options.timeoutMs || options.timeout || 12000),
    });
  const apiCollection = await collectApiModels({ all: true, dryRun: true, noFetch: true });
  const apiImport = await importApiModelDataset({ dryRun: true, post: true });

  return {
    generatedAt: new Date().toISOString(),
    apiModels: {
      staticCounts: {
        families: data.getApiModelFamilyOptions(data.staticApiModelDataset).length,
        models: data.staticApiModelDataset.models.length,
        providers: data.staticApiModelDataset.providers.length,
        plans: data.staticApiModelDataset.plans.length,
        offers: data.staticApiModelDataset.offers.length,
      },
      importPlan: apiImport.counts,
      collectionRun: apiCollection.run,
    },
    providerCandidates: summarizeCandidates(data.apiProviderCandidates, candidateProbes),
    officialPrices: summarizeOfficialSnapshot(officialSnapshot),
    p2Status: buildP2Status(data.apiProviderCandidates, officialSnapshot, apiImport, apiCollection),
  };
}

function buildP2Status(candidates, officialSnapshot, apiImport, apiCollection) {
  const openCandidateWork = candidates.filter((candidate) => candidate.status === "collector_todo" || candidate.status === "needs_review");
  const officialRun = officialSnapshot?.run || {};

  return {
    stage: "P2 手动更新闭环",
    status: "closeout_ready",
    completed: [
      "API 正式数据 dry-run 可重复生成，不写远端也能看到 families/models/providers/plans/offers 摘要。",
      "API 候选渠道有证据状态、下一步和复制上下文；P3 已把可核验候选以前台待解析口径展示。",
      "官方地区价保留最近一次全量采集摘要，并能区分 available、missing、needs_review、parse_failed。",
      "P2 默认不做每日自动调度；P3 前台展示待解析候选时保留明确来源和待解析提示。",
    ],
    stillOpen: [
      `${openCandidateWork.length} 个 API 候选渠道仍需按优先级补解析器或人工核验。`,
      officialRun.failureCount
        ? `官方地区价还有 ${officialRun.failureCount} 个 app/region 请求级失败项，当前作为后续解析器优化项保留。`
        : "官方地区价当前快照没有请求级失败项。",
      "Kimi/GLM/MiMo/StepFun 等官方价格页仍以官方入口和待解析口径为主，未硬填不可核验单价。",
    ],
    needsUserDecision: [
      "是否继续把未结构化价格的候选展示在前台：当前 P3 口径为允许，但必须明确标注待解析并保留官方来源。",
      "是否现在做每日自动调度/VPS worker：建议否，等 P3 再做。",
      "是否把官方地区价失败地区逐个修到 0：建议暂不作为 P2 阻塞。",
    ],
    gates: {
      apiImportDryRun: apiImport.dryRun && apiImport.database?.skipped === true ? "passed" : "needs_attention",
      apiCollectionNoFetch: apiCollection.run.status === "success" ? "passed" : "needs_attention",
      officialSnapshotAvailable: officialSnapshot ? "passed" : "missing",
    },
  };
}

function summarizeCandidates(candidates, probes) {
  const probesByCandidate = new Map();
  for (const probe of probes) {
    const list = probesByCandidate.get(probe.candidateId) || [];
    list.push(probe);
    probesByCandidate.set(probe.candidateId, list);
  }

  const byEvidence = countBy(candidates, (candidate) => candidate.evidenceStatus);
  const byStatus = countBy(candidates, (candidate) => candidate.status);
  const highPriority = candidates.filter((candidate) => candidate.priority === "high");

  return {
    total: candidates.length,
    byEvidence,
    byStatus,
    highPriorityCount: highPriority.length,
    rows: candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      priority: candidate.priority,
      status: candidate.status,
      evidenceStatus: candidate.evidenceStatus,
      url: candidate.url,
      pricingUrl: candidate.pricingUrl,
      nextStep: candidate.nextStep,
      probes: probesByCandidate.get(candidate.id) || [],
    })),
  };
}

function summarizeOfficialSnapshot(snapshot) {
  if (!snapshot) {
    return {
      available: false,
      message: "data/official-prices/latest.json not found.",
    };
  }

  const runItems = snapshot.run?.items || [];
  const failedItems = runItems.filter((item) => item.status !== "success");
  const failureGroups = groupBy(failedItems, (item) => `${item.status}: ${item.failureReason || "unknown"}`);

  return {
    available: true,
    generatedAt: snapshot.generatedAt,
    source: snapshot.source,
    scope: snapshot.scope,
    run: snapshot.run,
    topFailures: [...failureGroups.entries()]
      .map(([reason, items]) => ({
        reason,
        count: items.length,
        examples: items.slice(0, 8).map((item) => `${item.appSlug}/${item.countryCode}`),
      }))
      .sort((a, b) => b.count - a.count),
    unmatchedSample: (snapshot.unmatchedItems || []).slice(0, 12).map((item) => ({
      appSlug: item.appSlug,
      countryCode: item.countryCode,
      rawTitle: item.rawTitle,
      priceText: item.priceText,
      reason: item.reason,
    })),
  };
}

async function probeCandidateUrls(candidates, options) {
  const urls = [];
  for (const candidate of candidates) {
    urls.push({ candidateId: candidate.id, kind: "url", url: candidate.url });
    if (candidate.pricingUrl && candidate.pricingUrl !== candidate.url) {
      urls.push({ candidateId: candidate.id, kind: "pricingUrl", url: candidate.pricingUrl });
    }
  }

  const output = [];
  for (const item of urls) {
    output.push(await probeUrl(item, options));
  }
  return output;
}

async function probeUrl(item, options) {
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(item.url, options.timeoutMs);
    const contentType = response.headers.get("content-type") || "";
    const text = await limitedText(response, contentType);
    return {
      ...item,
      status: response.ok ? "ok" : "failed",
      httpStatus: response.status,
      finalUrl: response.url || item.url,
      title: extractTitle(text),
      contentType,
      durationMs: Date.now() - startedAt,
      errorMessage: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ...item,
      status: "failed",
      httpStatus: null,
      finalUrl: item.url,
      title: null,
      contentType: null,
      durationMs: Date.now() - startedAt,
      errorMessage: errorMessage(error),
    };
  }
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.5",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "user-agent": userAgent,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function limitedText(response, contentType) {
  if (contentType && !/text|html|json|xml|javascript/i.test(contentType)) return "";
  return (await response.text()).slice(0, 200000);
}

function renderMarkdownReport(result) {
  const candidateRows = result.providerCandidates.rows
    .map((candidate) => {
      const probeText = candidate.probes.length
        ? candidate.probes.map((probe) => `${probe.kind}:${probe.status}${probe.httpStatus ? `/${probe.httpStatus}` : ""}`).join(", ")
        : "未探测";
      return `| ${candidate.name} | ${candidate.priority} | ${candidate.status} | ${candidate.evidenceStatus} | ${probeText} | ${candidate.nextStep} |`;
    })
    .join("\n");
  const topFailures = result.officialPrices.available
    ? result.officialPrices.topFailures
      .map((item) => `| ${item.reason} | ${item.count} | ${item.examples.join(", ")} |`)
      .join("\n")
    : `| ${result.officialPrices.message} | 0 | - |`;

  return `# PriceAI P2 收口检查报告

> 生成时间：${result.generatedAt}  
> 阶段：${result.p2Status.stage}  
> 状态：${result.p2Status.status}

## 验收闸口

| 检查项 | 状态 |
| --- | --- |
| API 模型导入 dry-run | ${result.p2Status.gates.apiImportDryRun} |
| API 模型采集 no-fetch | ${result.p2Status.gates.apiCollectionNoFetch} |
| 官方地区价快照 | ${result.p2Status.gates.officialSnapshotAvailable} |

## API 正式数据

| 指标 | 数量 |
| --- | ---: |
| 模型族 | ${result.apiModels.importPlan.families} |
| 标准模型 | ${result.apiModels.importPlan.models} |
| 正式渠道 | ${result.apiModels.importPlan.providers} |
| 套餐 | ${result.apiModels.importPlan.plans} |
| 报价 | ${result.apiModels.importPlan.offers} |

## API 候选渠道

| 候选 | 优先级 | 状态 | 证据 | URL 探测 | 下一步 |
| --- | --- | --- | --- | --- | --- |
${candidateRows}

## 官方地区价失败摘要

| 类型 | 数量 | 示例 |
| --- | ---: | --- |
${topFailures}

## 已完成

${result.p2Status.completed.map((item) => `- ${item}`).join("\n")}

## 仍需后续处理

${result.p2Status.stillOpen.map((item) => `- ${item}`).join("\n")}

## 需要用户确认

${result.p2Status.needsUserDecision.map((item) => `- ${item}`).join("\n")}
`;
}

async function loadApiModelModule() {
  const sourcePath = path.join(repoRoot, "src", "lib", "api-models.ts");
  const source = await readFile(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
      esModuleInterop: true,
    },
  }).outputText;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "priceai-p2-check-"));
  const tempFile = path.join(tempDir, "api-models.mjs");
  await writeFile(tempFile, output, "utf8");

  try {
    return await import(`${pathToFileURL(tempFile).href}?ts=${Date.now()}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function mkdtemp(prefix) {
  const { mkdtemp: makeTempDir } = await import("node:fs/promises");
  return makeTempDir(prefix);
}

async function readOptionalJson(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(await readFile(filePath, "utf8"));
}

function countBy(items, keyFn) {
  return Object.fromEntries([...groupBy(items, keyFn).entries()].map(([key, rows]) => [key, rows.length]));
}

function groupBy(items, keyFn) {
  const output = new Map();
  for (const item of items) {
    const key = keyFn(item);
    const rows = output.get(key) || [];
    rows.push(item);
    output.set(key, rows);
  }
  return output;
}

function extractTitle(text) {
  if (!text) return null;
  const match = text.match(/<title[^>]*>(.*?)<\/title>/is);
  if (!match) return null;
  return decodeHtml(match[1].replace(/\s+/g, " ").trim()).slice(0, 160);
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, `"`)
    .replace(/&#39;/g, "'");
}

function printSummary(result) {
  console.log(
    [
      "P2 closeout check.",
      `status=${result.p2Status.status}`,
      `apiModels=${result.apiModels.importPlan.models}`,
      `apiProviders=${result.apiModels.importPlan.providers}`,
      `apiOffers=${result.apiModels.importPlan.offers}`,
      `candidates=${result.providerCandidates.total}`,
      `officialAvailable=${result.officialPrices.run?.availableCount ?? 0}`,
      `officialFailures=${result.officialPrices.run?.failureCount ?? 0}`,
    ].join(" "),
  );
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
    write: truthyOption(options.write),
    json: truthyOption(options.json),
    noFetch: truthyOption(options.noFetch ?? options["no-fetch"]),
    timeoutMs: options.timeoutMs ?? options["timeout-ms"] ?? options.timeout,
    officialSnapshot: options.officialSnapshot ?? options["official-snapshot"],
  };
}

function truthyOption(value) {
  return value === true || value === "true" || value === "1" || value === "";
}

function isCli() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
