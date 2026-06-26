import { spawnSync } from "node:child_process";
import { join } from "node:path";

const versionId = process.argv[2];

if (!versionId || !/^[a-f0-9-]{36}$/i.test(versionId)) {
  console.error("Usage: npm run promote:cloudflare -- <worker-version-id>");
  process.exit(1);
}

const message = process.env.CLOUDFLARE_PROMOTE_MESSAGE || `Promote ${versionId}`;
const wrangler = join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);

const result = spawnSync(
  wrangler,
  [
    "versions",
    "deploy",
    `${versionId}@100`,
    "--name",
    "priceai-cloudflare-poc",
    "--message",
    message,
    "--yes",
  ],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

if (result.error) {
  console.error(`Cloudflare version promotion failed: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
