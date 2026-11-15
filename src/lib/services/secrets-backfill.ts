import { prisma } from "../db";
import { asIntegrationRecord, needsReencryption, sealIntegrations, secretsEncryptionEnabled, SecretsConfigError } from "../secrets";

export interface SecretsBackfillResult {
  sites: number;
  /** Sites whose integrations were (or, in a dry run, would be) re-written. */
  updated: number;
  /** Sites changed concurrently while the backfill ran (left for the next run). */
  skipped: number;
  /** Sites whose values could not be decrypted with the configured keys. */
  failed: string[];
}

/**
 * Encrypts every legacy plaintext integration secret, and re-encrypts values written with a previous key, using the
 * current `SECRETS_ENCRYPTION_KEY`. Idempotent; safe to run while the app is up (each row is only written if it did
 * not change since it was read). Used by `npm run secrets:encrypt`.
 */
export async function backfillIntegrationSecrets(opts: { dryRun?: boolean; batchSize?: number } = {}): Promise<SecretsBackfillResult> {
  if (!secretsEncryptionEnabled()) throw new SecretsConfigError("Set SECRETS_ENCRYPTION_KEY before encrypting stored secrets");
  const result: SecretsBackfillResult = { sites: 0, updated: 0, skipped: 0, failed: [] };
  const take = opts.batchSize ?? 200;
  let cursor: string | undefined;
  for (;;) {
    const sites = await prisma.site.findMany({
      select: { id: true, integrations: true, updatedAt: true },
      orderBy: { id: "asc" },
      take,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
    if (!sites.length) break;
    cursor = sites[sites.length - 1].id;
    for (const site of sites) {
      result.sites += 1;
      const stored = asIntegrationRecord(site.integrations);
      if (!Object.values(stored).some(needsReencryption)) continue;
      let sealed: Record<string, string>;
      try {
        sealed = sealIntegrations(stored);
      } catch {
        result.failed.push(site.id);
        continue;
      }
      if (opts.dryRun) {
        result.updated += 1;
        continue;
      }
      // updatedAt is bumped by every write, so a concurrent edit makes this a no-op instead of being overwritten
      const { count } = await prisma.site.updateMany({ where: { id: site.id, updatedAt: site.updatedAt }, data: { integrations: sealed } });
      if (count) result.updated += 1;
      else result.skipped += 1;
    }
    if (sites.length < take) break;
  }
  return result;
}
