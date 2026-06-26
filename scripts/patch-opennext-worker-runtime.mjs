import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const serverRoot = join(process.cwd(), ".open-next", "server-functions", "default");
const manifestFile = join(serverRoot, ".next", "server", "middleware-manifest.json");
const handlerFile = join(serverRoot, "handler.mjs");

const emptyMiddlewareManifest = {
  version: 3,
  middleware: {},
  functions: {},
  sortedMiddleware: [],
};

assertEmptyMiddlewareManifest();
patchHandler();

console.log("OpenNext Worker runtime patch complete: empty middleware manifest is inlined.");

function assertEmptyMiddlewareManifest() {
  if (!existsSync(manifestFile)) {
    throw new Error(`Missing middleware manifest: ${manifestFile}`);
  }

  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (JSON.stringify(manifest) !== JSON.stringify(emptyMiddlewareManifest)) {
    throw new Error("Refusing to patch non-empty middleware manifest for Cloudflare Worker runtime.");
  }
}

function patchHandler() {
  if (!existsSync(handlerFile)) {
    throw new Error(`Missing OpenNext handler bundle: ${handlerFile}`);
  }

  const source = readFileSync(handlerFile, "utf8");
  const target = "getMiddlewareManifest(){return this.minimalMode?null:require(this.middlewareManifestPath)}";
  const replacement = "getMiddlewareManifest(){return null}";
  const count = source.split(target).length - 1;

  if (count === 0 && source.includes(replacement)) {
    return;
  }

  if (count !== 1) {
    throw new Error(`Expected one middleware manifest require in OpenNext handler, found ${count}.`);
  }

  writeFileSync(handlerFile, source.replace(target, replacement));
}
