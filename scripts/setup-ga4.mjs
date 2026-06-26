#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const API_ROOT = "https://analyticsadmin.googleapis.com/v1beta";
const DEFAULT_SITE_URL = "https://priceai.cc";
const DEFAULT_PROPERTY_NAME = "PriceAI";
const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const DEFAULT_CURRENCY = "CNY";

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

async function main() {
  const siteUrl = normalizeSiteUrl(options.siteUrl || envValue("GA4_SITE_URL") || DEFAULT_SITE_URL);
  const propertyDisplayName = options.property || envValue("GA4_PROPERTY_DISPLAY_NAME") || DEFAULT_PROPERTY_NAME;
  const streamDisplayName = options.stream || envValue("GA4_STREAM_DISPLAY_NAME") || `${propertyDisplayName} Web`;
  const timeZone = options.timeZone || envValue("GA4_TIME_ZONE") || DEFAULT_TIME_ZONE;
  const currencyCode = options.currency || envValue("GA4_CURRENCY") || DEFAULT_CURRENCY;
  const token = accessToken();

  const accounts = await listAccountSummaries(token);
  if (options.listAccounts) {
    printAccounts(accounts);
    return;
  }

  const account = selectAccount(accounts, options.account);
  const property = await findOrCreateProperty(token, account, {
    displayName: propertyDisplayName,
    timeZone,
    currencyCode,
  });
  const dataStream = await findOrCreateWebStream(token, property.name, {
    displayName: streamDisplayName,
    siteUrl,
  });

  const measurementId = dataStream.webStreamData?.measurementId;
  if (!measurementId) {
    throw new Error(`GA4 data stream created, but measurementId was not returned. Stream: ${dataStream.name}`);
  }

  if (options.writeEnv) {
    upsertEnv(".env.local", "NEXT_PUBLIC_GA_MEASUREMENT_ID", measurementId);
  }

  const result = {
    account: account.account,
    accountDisplayName: account.displayName,
    property: property.name,
    propertyDisplayName: property.displayName,
    dataStream: dataStream.name,
    dataStreamDisplayName: dataStream.displayName,
    defaultUri: dataStream.webStreamData?.defaultUri,
    measurementId,
    wroteEnvLocal: Boolean(options.writeEnv),
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("GA4 setup ready.");
  console.log(`Account: ${result.accountDisplayName} (${result.account})`);
  console.log(`Property: ${result.propertyDisplayName} (${result.property})`);
  console.log(`Web stream: ${result.dataStreamDisplayName} (${result.dataStream})`);
  console.log(`Site URL: ${result.defaultUri}`);
  console.log(`Measurement ID: ${result.measurementId}`);
  if (options.writeEnv) {
    console.log("Updated .env.local: NEXT_PUBLIC_GA_MEASUREMENT_ID");
  } else {
    console.log("Tip: run with --write-env to write NEXT_PUBLIC_GA_MEASUREMENT_ID into .env.local.");
  }
}

async function findOrCreateProperty(token, account, input) {
  const existing = account.propertySummaries?.find((property) => property.displayName === input.displayName);
  if (existing?.property) {
    const property = await gaFetch(token, `/${existing.property}`);
    console.log(`Reusing GA4 property: ${property.displayName} (${property.name})`);
    return property;
  }

  console.log(`Creating GA4 property: ${input.displayName}`);
  return gaFetch(token, "/properties", {
    method: "POST",
    body: {
      parent: account.account,
      displayName: input.displayName,
      timeZone: input.timeZone,
      currencyCode: input.currencyCode,
    },
  });
}

async function findOrCreateWebStream(token, propertyName, input) {
  const streams = await listDataStreams(token, propertyName);
  const existing = streams.find((stream) => {
    if (stream.type !== "WEB_DATA_STREAM") return false;
    return stream.displayName === input.displayName || sameSiteUrl(stream.webStreamData?.defaultUri, input.siteUrl);
  });

  if (existing) {
    console.log(`Reusing GA4 web stream: ${existing.displayName} (${existing.name})`);
    return existing;
  }

  console.log(`Creating GA4 web stream: ${input.displayName}`);
  return gaFetch(token, `/${propertyName}/dataStreams`, {
    method: "POST",
    body: {
      type: "WEB_DATA_STREAM",
      displayName: input.displayName,
      webStreamData: {
        defaultUri: input.siteUrl,
      },
    },
  });
}

async function listAccountSummaries(token) {
  const items = [];
  let pageToken = "";

  do {
    const params = new URLSearchParams({ pageSize: "200" });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await gaFetch(token, `/accountSummaries?${params.toString()}`);
    items.push(...(page.accountSummaries || []));
    pageToken = page.nextPageToken || "";
  } while (pageToken);

  if (!items.length) {
    throw new Error(
      [
        "No Google Analytics accounts were returned.",
        "Open https://analytics.google.com once to create/accept a Google Analytics account, then rerun this script.",
      ].join("\n"),
    );
  }

  return items;
}

async function listDataStreams(token, propertyName) {
  const items = [];
  let pageToken = "";

  do {
    const params = new URLSearchParams({ pageSize: "200" });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await gaFetch(token, `/${propertyName}/dataStreams?${params.toString()}`);
    items.push(...(page.dataStreams || []));
    pageToken = page.nextPageToken || "";
  } while (pageToken);

  return items;
}

async function gaFetch(token, path, init = {}) {
  const response = await fetch(`${API_ROOT}${path}`, {
    method: init.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    const message = data.error?.message || response.statusText;
    const code = data.error?.status || response.status;
    throw new Error(
      [
        `Google Analytics Admin API error: ${code}`,
        message,
        "",
        "If this is an auth/scope problem, rerun:",
        "gcloud auth application-default login --scopes=https://www.googleapis.com/auth/analytics.edit,https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/cloud-platform",
      ].join("\n"),
    );
  }

  return data;
}

function accessToken() {
  const fromEnv = process.env.GOOGLE_OAUTH_ACCESS_TOKEN || process.env.GA4_ACCESS_TOKEN;
  if (fromEnv) return fromEnv;

  try {
    return execFileSync("gcloud", ["auth", "application-default", "print-access-token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(
      [
        "Google Application Default Credentials are not ready.",
        "",
        "Install/login gcloud, then run:",
        "gcloud auth login",
        "gcloud services enable analyticsadmin.googleapis.com analyticsdata.googleapis.com",
        "gcloud auth application-default login --scopes=https://www.googleapis.com/auth/analytics.edit,https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/cloud-platform",
        "",
        "Then rerun: npm run setup:ga4 -- --write-env",
      ].join("\n"),
    );
  }
}

function selectAccount(accounts, accountInput) {
  if (!accountInput && accounts.length === 1) return accounts[0];

  if (accountInput) {
    const normalized = normalizeResourceName(accountInput, "accounts");
    const found = accounts.find((account) => account.account === normalized);
    if (found) return found;
    throw new Error(`Google Analytics account not found: ${normalized}`);
  }

  printAccounts(accounts);
  throw new Error("Multiple Google Analytics accounts found. Rerun with --account accounts/XXXX.");
}

function printAccounts(accounts) {
  console.log("Google Analytics accounts:");
  for (const account of accounts) {
    console.log(`- ${account.account}  ${account.displayName}`);
  }
}

function upsertEnv(filePath, key, value) {
  const current = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const lines = current.split(/\r?\n/);
  const nextLine = `${key}=${value}`;
  let replaced = false;

  const next = lines.map((line) => {
    if (line.match(new RegExp(`^${escapeRegExp(key)}=`))) {
      replaced = true;
      return nextLine;
    }
    return line;
  });

  if (!replaced) {
    if (next.length && next[next.length - 1] !== "") next.push("");
    next.push(nextLine);
  }

  writeFileSync(filePath, `${next.join("\n").replace(/\n+$/, "")}\n`);
}

function parseArgs(args) {
  const parsed = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--list-accounts") parsed.listAccounts = true;
    else if (arg === "--write-env") parsed.writeEnv = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--account") parsed.account = args[++index];
    else if (arg === "--property") parsed.property = args[++index];
    else if (arg === "--stream") parsed.stream = args[++index];
    else if (arg === "--site-url") parsed.siteUrl = args[++index];
    else if (arg === "--time-zone") parsed.timeZone = args[++index];
    else if (arg === "--currency") parsed.currency = args[++index];
    else throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage:
  npm run setup:ga4 -- [options]

Options:
  --list-accounts          List Google Analytics accounts and exit.
  --account accounts/123   Use a specific Google Analytics account.
  --property PriceAI       GA4 property display name. Default: PriceAI.
  --stream "PriceAI Web"   Web stream display name. Default: "<property> Web".
  --site-url URL           Web stream URL. Default: https://priceai.cc.
  --time-zone Zone         Reporting time zone. Default: Asia/Shanghai.
  --currency Code          Reporting currency. Default: CNY.
  --write-env              Write NEXT_PUBLIC_GA_MEASUREMENT_ID to .env.local.
  --json                   Print machine-readable result.
`);
}

function normalizeResourceName(value, collection) {
  if (value.startsWith(`${collection}/`)) return value;
  if (/^\d+$/.test(value)) return `${collection}/${value}`;
  return value;
}

function normalizeSiteUrl(value) {
  const url = new URL(value);
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function sameSiteUrl(left, right) {
  if (!left || !right) return false;
  try {
    return normalizeSiteUrl(left) === normalizeSiteUrl(right);
  } catch {
    return left === right;
  }
}

function envValue(key) {
  return process.env[key]?.trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
