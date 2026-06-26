import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

const root = process.cwd();
const nextEnvModule = join(root, ".open-next/cloudflare/next-env.mjs");
const openNextRoot = join(root, ".open-next");

if (existsSync(nextEnvModule)) {
  writeFileSync(
    nextEnvModule,
    [
      "export const production = {};",
      "export const development = {};",
      "export const test = {};",
      "",
    ].join("\n"),
  );
}

let removedCount = 0;

if (existsSync(openNextRoot)) {
  for (const file of listEnvFiles(openNextRoot)) {
    rmSync(file, { force: true });
    removedCount += 1;
  }
}

console.log(`OpenNext env sanitization complete: removed ${removedCount} .env file(s).`);

function listEnvFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stats = statSync(path);

    if (stats.isDirectory()) {
      files.push(...listEnvFiles(path));
    } else if (basename(path).startsWith(".env")) {
      files.push(path);
    }
  }

  return files.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
}
