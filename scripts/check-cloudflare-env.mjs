import {
  CLOUDFLARE_BUILD_REQUIRED_ENV,
  CLOUDFLARE_OPTIONAL_ENV,
  CLOUDFLARE_REQUIRED_ENV,
  loadCloudflareLocalEnv,
  missingEnv,
} from "./cloudflare-env.mjs";

const target = parseTarget(process.argv.slice(2));
loadCloudflareLocalEnv();

const required = target === "build" ? CLOUDFLARE_BUILD_REQUIRED_ENV : CLOUDFLARE_REQUIRED_ENV;
const missingRequired = missingEnv(required);
const missingOptional = missingEnv(CLOUDFLARE_OPTIONAL_ENV);

if (missingRequired.length > 0) {
  console.error(`Missing required Cloudflare ${target} env:`);
  for (const name of missingRequired) {
    console.error(`- ${name}`);
  }
  process.exit(1);
}

console.log(`Cloudflare ${target} required env is present.`);

if (missingOptional.length > 0) {
  console.log(`Optional env not set: ${missingOptional.join(", ")}`);
}

function parseTarget(args) {
  if (args.includes("--build")) return "build";
  const targetArg = args.find((arg) => arg.startsWith("--target="));
  if (!targetArg) return "deploy";
  const targetValue = targetArg.slice("--target=".length);
  return targetValue === "build" ? "build" : "deploy";
}
