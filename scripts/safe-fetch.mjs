import dns from "node:dns/promises";

const DEFAULT_MAX_REDIRECTS = 3;

export function isPrivateAddress(address) {
  const lower = String(address || "").trim().toLowerCase();
  const ipv4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);

  if (ipv4) {
    const [a, b, c, d] = ipv4.slice(1).map(Number);
    if ([a, b, c, d].some((part) => part < 0 || part > 255)) return true;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (lower === "localhost") return true;
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.split(":").pop() || "");
  return false;
}

export async function ensurePublicHost(hostname) {
  if (!hostname) throw new Error("URL 缺少主机名。");
  if (isPrivateAddress(hostname)) throw new Error("不允许访问内部 IP。");

  let records = [];
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error("无法解析该主机名。");
  }

  if (!records.length) throw new Error("无法解析该主机名。");
  for (const record of records) {
    if (isPrivateAddress(record.address)) throw new Error("不允许访问内部 IP。");
  }
}

export async function safeFetch(rawUrl, init = {}) {
  let url = new URL(rawUrl);
  await validateFetchUrl(url);

  const maxRedirects = init.redirect === "manual" ? 0 : DEFAULT_MAX_REDIRECTS;
  let response = await fetch(url, { ...init, redirect: "manual" });

  for (let hop = 0; response.status >= 300 && response.status < 400; hop += 1) {
    const location = response.headers.get("location");
    if (!location) break;
    if (hop >= maxRedirects) throw new Error("重定向过多。");

    url = new URL(location, url);
    await validateFetchUrl(url);
    response = await fetch(url, { ...init, redirect: "manual" });
  }

  return response;
}

async function validateFetchUrl(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("仅允许 http/https。");
  }
  await ensurePublicHost(url.hostname);
}
