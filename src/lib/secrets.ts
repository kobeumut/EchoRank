import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { HttpError } from "./http";

/**
 * Encryption at rest for per-site integration secrets (`Site.integrations`): AES-256-GCM with a 32-byte key from
 * `SECRETS_ENCRYPTION_KEY`. Stored format: `enc:v1:<keyId>:<iv>.<ciphertext>.<tag>` (base64url parts). `keyId` is a
 * short fingerprint of the key so values written with an older key (listed in `SECRETS_ENCRYPTION_KEY_PREVIOUS`)
 * can still be read during a rotation. The integration name is bound as additional authenticated data, so a
 * ciphertext copied into another field does not decrypt.
 *
 * Values without the `enc:v1:` prefix are legacy plaintext rows; they are still readable and are encrypted on the
 * next write or by `npm run secrets:encrypt`.
 */

const PREFIX = "enc:v1:";
const IV_BYTES = 12;

/** Missing / wrong key configuration: surfaced as HTTP 503 with a message that never contains secret material. */
export class SecretsConfigError extends HttpError {
  constructor(message: string) {
    super(503, message);
  }
}

type Key = { id: string; key: Buffer };

function parseKey(raw: string, name: string): Key {
  const value = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new SecretsConfigError(`${name} must be 32 random bytes, hex (64 chars) or base64 encoded (openssl rand -base64 32)`);
  }
  return { id: createHash("sha256").update(key).digest("hex").slice(0, 8), key };
}

let cache: { raw: string; current: Key | null; all: Key[] } | null = null;

function keys(): { current: Key | null; all: Key[] } {
  const current = process.env.SECRETS_ENCRYPTION_KEY?.trim() ?? "";
  const previous = process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS?.trim() ?? "";
  const raw = `${current}\n${previous}`;
  if (cache?.raw === raw) return cache;
  const cur = current ? parseKey(current, "SECRETS_ENCRYPTION_KEY") : null;
  const old = previous.split(",").map((v) => v.trim()).filter(Boolean).map((v) => parseKey(v, "SECRETS_ENCRYPTION_KEY_PREVIOUS"));
  cache = { raw, current: cur, all: [...(cur ? [cur] : []), ...old] };
  return cache;
}

/** True when `SECRETS_ENCRYPTION_KEY` is set (new secrets are encrypted). */
export function secretsEncryptionEnabled(): boolean {
  return keys().current !== null;
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

let warned = false;

/**
 * Encrypts `plaintext` for storage. Without a key, development keeps plaintext (with a one-time warning) and
 * production (`NODE_ENV=production`) refuses, so secrets are never silently written unencrypted there.
 */
export function encryptSecret(plaintext: string, context: string): string {
  if (isEncryptedSecret(plaintext)) return plaintext;
  const { current } = keys();
  if (!current) {
    if (process.env.NODE_ENV === "production") {
      throw new SecretsConfigError("SECRETS_ENCRYPTION_KEY is not set: refusing to store an integration secret unencrypted");
    }
    if (!warned) {
      warned = true;
      console.warn("[secrets] SECRETS_ENCRYPTION_KEY is not set: integration secrets are stored unencrypted (development only)");
    }
    return plaintext;
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", current.key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${current.id}:${[iv, ciphertext, tag].map((b) => b.toString("base64url")).join(".")}`;
}

/** Decrypts a stored value; legacy plaintext is returned unchanged. Throws when no configured key can open it. */
export function decryptSecret(stored: string, context: string): string {
  if (!isEncryptedSecret(stored)) return stored;
  const [keyId, payload = ""] = stored.slice(PREFIX.length).split(":", 2);
  const [iv, ciphertext, tag] = payload.split(".").map((part) => Buffer.from(part, "base64url"));
  const key = keys().all.find((k) => k.id === keyId);
  if (!key) throw new SecretsConfigError(`No configured encryption key (id ${keyId}) can decrypt this secret`);
  if (!iv || iv.length !== IV_BYTES || !ciphertext || !tag || tag.length !== 16) throw new SecretsConfigError("Malformed encrypted secret");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.key, iv);
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretsConfigError("Encrypted secret failed authentication (wrong key or tampered value)");
  }
}

/** True when the value is plaintext or was written with a key other than the current one. */
export function needsReencryption(stored: string): boolean {
  const { current } = keys();
  if (!current) return false;
  return !stored.startsWith(`${PREFIX}${current.id}:`);
}

// ---- Site.integrations helpers ----

export type IntegrationRecord = Record<string, string>;

const integrationContext = (name: string) => `site.integrations:${name}`;

export function asIntegrationRecord(value: unknown): IntegrationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}

/** Plaintext value of one integration secret (undefined when unset). */
export function readIntegrationSecret(stored: unknown, name: string): string | undefined {
  const value = asIntegrationRecord(stored)[name];
  return value ? decryptSecret(value, integrationContext(name)) : undefined;
}

/** Encrypts every value of an integrations record for storage (already current-key values are kept as they are). */
export function sealIntegrations(record: IntegrationRecord): IntegrationRecord {
  return Object.fromEntries(Object.entries(record).map(([name, value]) => {
    const plain = needsReencryption(value) ? decryptSecret(value, integrationContext(name)) : value;
    return [name, isEncryptedSecret(plain) ? plain : encryptSecret(plain, integrationContext(name))];
  }));
}

/** Decrypts a stored integrations record; values that cannot be decrypted are reported as null. */
export function openIntegrations(stored: unknown): Record<string, string | null> {
  return Object.fromEntries(Object.entries(asIntegrationRecord(stored)).map(([name, value]) => {
    try {
      return [name, decryptSecret(value, integrationContext(name))];
    } catch {
      return [name, null];
    }
  }));
}
