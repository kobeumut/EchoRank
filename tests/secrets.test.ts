import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret, isEncryptedSecret, openIntegrations, readIntegrationSecret, sealIntegrations, SecretsConfigError } from "@/lib/secrets";
import { getIntegration, setIntegration } from "@/lib/distribution/config";
import { createSite, getSiteOrThrow, updateSite } from "@/lib/services/sites";
import { backfillIntegrationSecrets } from "@/lib/services/secrets-backfill";
import { resetDb } from "./helpers";

const KEY = randomBytes(32).toString("base64");
const OLD_KEY = randomBytes(32).toString("hex");
const SA_JSON = '{"type":"service_account","client_email":"x@y.iam.gserviceaccount.com","private_key":"-----BEGIN"}';

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("SECRETS_ENCRYPTION_KEY", KEY);
  vi.stubEnv("SECRETS_ENCRYPTION_KEY_PREVIOUS", "");
});

afterEach(() => vi.unstubAllEnvs());

describe("AES-256-GCM secret encryption", () => {
  it("round-trips with a fresh IV and never stores the plaintext", () => {
    const a = encryptSecret("indexnow-key-0123456789abcdef", "ctx");
    const b = encryptSecret("indexnow-key-0123456789abcdef", "ctx");
    expect(a).toMatch(/^enc:v1:[0-9a-f]{8}:/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("indexnow-key");
    expect(decryptSecret(a, "ctx")).toBe("indexnow-key-0123456789abcdef");
  });

  it("rejects tampered values, a wrong context and a missing key", () => {
    const sealed = encryptSecret("s3cret-value-1234", "site.integrations:webhookSecret");
    const parts = sealed.split(".");
    parts[1] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."), "site.integrations:webhookSecret")).toThrow(SecretsConfigError);
    expect(() => decryptSecret(sealed, "site.integrations:indexnowKey")).toThrow(/authentication/); // AAD binds the field
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
    expect(() => decryptSecret(sealed, "site.integrations:webhookSecret")).toThrow(/No configured encryption key/);
  });

  it("validates the key format", () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", "too-short");
    expect(() => encryptSecret("x", "ctx")).toThrow(/32 random bytes/);
  });

  it("reads values written with a previous key during rotation", () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", OLD_KEY);
    const old = sealIntegrations({ webhookSecret: "rotate-me-0123456789" }).webhookSecret;
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", KEY);
    vi.stubEnv("SECRETS_ENCRYPTION_KEY_PREVIOUS", OLD_KEY);
    expect(decryptSecret(old, "site.integrations:webhookSecret")).toBe("rotate-me-0123456789");
    const resealed = sealIntegrations({ webhookSecret: old });
    expect(resealed.webhookSecret).not.toBe(old);
    expect(readIntegrationSecret(resealed, "webhookSecret")).toBe("rotate-me-0123456789");
  });

  it("without a key: plaintext in development, refused in production", () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", "");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(encryptSecret("plain-dev-secret", "ctx")).toBe("plain-dev-secret");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => encryptSecret("plain-prod-secret", "ctx")).toThrow(/SECRETS_ENCRYPTION_KEY is not set/);
  });

  it("legacy plaintext values stay readable; undecryptable ones are reported as null", () => {
    expect(readIntegrationSecret({ indexnowKey: "legacy-plaintext-key" }, "indexnowKey")).toBe("legacy-plaintext-key");
    const sealed = sealIntegrations({ indexnowKey: "abc" });
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
    expect(openIntegrations(sealed)).toEqual({ indexnowKey: null });
  });
});

describe("Site.integrations at rest", () => {
  it("encrypts on create/update/setIntegration and keeps last-4 masking in API responses", async () => {
    const created = await createSite({ url: "https://secrets.example.com", integrations: { webhookSecret: "whsec-0123456789abcdefWXYZ" } });
    expect(created.integrations).toEqual({ webhookSecret: "…WXYZ" });

    const raw = async () => (await prisma.site.findUniqueOrThrow({ where: { id: created.id } })).integrations as Record<string, string>;
    expect(isEncryptedSecret((await raw()).webhookSecret)).toBe(true);
    expect(JSON.stringify(await raw())).not.toContain("whsec-0123456789");

    const updated = await updateSite(created.id, { integrations: { googleServiceAccount: SA_JSON } });
    expect(updated.integrations).toEqual({ webhookSecret: "…WXYZ", googleServiceAccount: "••••" });
    expect(JSON.stringify(await raw())).not.toContain("private_key");

    await setIntegration(await getSiteOrThrow(created.id), "indexnowKey", "0123456789abcdef0123456789abcdef");
    const site = await getSiteOrThrow(created.id);
    expect(getIntegration(site, "indexnowKey")).toBe("0123456789abcdef0123456789abcdef");
    expect(getIntegration(site, "googleServiceAccount")).toBe(SA_JSON);
    expect(Object.values(await raw()).every(isEncryptedSecret)).toBe(true);
  });

  it("backfill encrypts legacy plaintext rows, is idempotent and supports a dry run", async () => {
    const site = await prisma.site.create({
      data: { url: "https://legacy.example.com", title: "legacy", integrations: { indexnowKey: "legacy-plaintext-indexnow-key", webhookSecret: "legacy-secret-value" } },
    });
    const dry = await backfillIntegrationSecrets({ dryRun: true });
    expect(dry).toMatchObject({ sites: 1, updated: 1, failed: [] });
    expect((await getSiteOrThrow(site.id)).integrations).toEqual({ indexnowKey: "legacy-plaintext-indexnow-key", webhookSecret: "legacy-secret-value" });

    expect(await backfillIntegrationSecrets()).toMatchObject({ sites: 1, updated: 1, skipped: 0, failed: [] });
    const stored = (await getSiteOrThrow(site.id)).integrations as Record<string, string>;
    expect(Object.values(stored).every(isEncryptedSecret)).toBe(true);
    expect(getIntegration(await getSiteOrThrow(site.id), "indexnowKey")).toBe("legacy-plaintext-indexnow-key");

    expect(await backfillIntegrationSecrets()).toMatchObject({ updated: 0 }); // nothing left to do
  });

  it("backfill requires a key and reports rows it cannot decrypt", async () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", OLD_KEY);
    const site = await createSite({ url: "https://rotated.example.com", integrations: { webhookSecret: "old-key-secret-123456" } });
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", KEY);
    expect(await backfillIntegrationSecrets()).toMatchObject({ updated: 0, failed: [site.id] });
    vi.stubEnv("SECRETS_ENCRYPTION_KEY_PREVIOUS", OLD_KEY);
    expect(await backfillIntegrationSecrets()).toMatchObject({ updated: 1, failed: [] });
    vi.stubEnv("SECRETS_ENCRYPTION_KEY_PREVIOUS", "");
    expect(getIntegration(await getSiteOrThrow(site.id), "webhookSecret")).toBe("old-key-secret-123456");

    vi.stubEnv("SECRETS_ENCRYPTION_KEY", "");
    await expect(backfillIntegrationSecrets()).rejects.toThrow(/Set SECRETS_ENCRYPTION_KEY/);
  });
});
