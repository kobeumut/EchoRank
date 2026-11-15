// Encrypts legacy plaintext integration secrets (Site.integrations) with SECRETS_ENCRYPTION_KEY, and re-encrypts values
// written with a key listed in SECRETS_ENCRYPTION_KEY_PREVIOUS. Usage: npm run secrets:encrypt [-- --dry-run]
import { prisma } from "../src/lib/db";
import { backfillIntegrationSecrets } from "../src/lib/services/secrets-backfill";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const result = await backfillIntegrationSecrets({ dryRun });
  console.log(
    `${dryRun ? "[dry run] " : ""}Checked ${result.sites} site(s): ${result.updated} ${dryRun ? "would be " : ""}encrypted, ` +
      `${result.skipped} changed concurrently (run again), ${result.failed.length} could not be decrypted` +
      (result.failed.length ? ` (site ids: ${result.failed.join(", ")}; add the old key to SECRETS_ENCRYPTION_KEY_PREVIOUS)` : ""),
  );
  if (result.failed.length || result.skipped) process.exitCode = 1;
}

main()
  .catch((err: Error) => {
    console.error(`Secret backfill failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
