/**
 * Tenant registry — one record per GitHub organization that has onboarded.
 *
 * Stored in Cloudflare KV. The shared worker looks up the record on every
 * incoming GitHub webhook and uses its `webhookSecret` to verify the signature
 * and its `dispatchPat` to forward a `repository_dispatch` to the sync repo.
 */

export interface TenantRecord {
  /** GitHub org name, lowercase */
  org: string;
  /** Full name of the sync repo (e.g. "acme/lark-github-sync") */
  syncRepo: string;
  /** Fine-grained PAT with contents:write + actions:write on the sync repo */
  dispatchPat: string;
  /** Shared secret for GitHub webhook HMAC */
  webhookSecret: string;
  /** Lark chat ID for approval cards */
  adminChatId: string;
  /** ISO timestamp */
  registeredAt: string;
  /** Last time this tenant was touched (registration or rotation) */
  updatedAt: string;
}

export interface KVEnv {
  TENANTS: KVNamespace;
}

export async function getByOrg(env: KVEnv, org: string): Promise<TenantRecord | null> {
  const raw = await env.TENANTS.get(`gh:${org.toLowerCase()}`, 'json');
  return (raw as TenantRecord) ?? null;
}

export async function put(env: KVEnv, rec: TenantRecord): Promise<void> {
  const now = new Date().toISOString();
  const record: TenantRecord = {
    ...rec,
    org: rec.org.toLowerCase(),
    registeredAt: rec.registeredAt || now,
    updatedAt: now,
  };
  await env.TENANTS.put(`gh:${record.org}`, JSON.stringify(record));
}
