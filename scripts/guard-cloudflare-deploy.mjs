const allowDeploy = process.env.PRICEAI_ALLOW_DIRECT_CLOUDFLARE_DEPLOY === "1";

if (!allowDeploy) {
  console.error(
    [
      "Direct Cloudflare deploy is disabled.",
      "Use `npm run upload:cloudflare` to create a Worker Version, run smoke on its Preview URL, then promote with `wrangler versions deploy <version-id>@100`.",
      "Set PRICEAI_ALLOW_DIRECT_CLOUDFLARE_DEPLOY=1 only for an intentional emergency deploy.",
    ].join("\n"),
  );
  process.exit(1);
}
