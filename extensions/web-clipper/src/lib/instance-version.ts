import browser from "webextension-polyfill";
import { InstanceError, type InstanceErrorKind } from "./errors";
import { getInstanceProfile, type InstanceFetchDeps, type MemosCredentials } from "./memos-client";

/**
 * The instance version is runtime state of the *server*, not user config, so it lives in a
 * per-device local cache (keyed by instance URL) rather than synced account metadata.
 * That keeps a value that can drift (server upgrades) out of the synced identity record, where
 * a stale entry would wrongly gate the clipper across every device.
 */

/** Exported so tests seed the cache through the same contract the code reads. */
export const VERSION_CACHE_KEY = "memosInstanceVersion";
type CachedVersion = { instanceUrl: string; version: string; webClipperSupported?: boolean };

async function cachedCapability(instanceUrl: string): Promise<boolean> {
  const stored = await browser.storage.local.get(VERSION_CACHE_KEY);
  const record = stored[VERSION_CACHE_KEY] as CachedVersion | undefined;
  return record?.instanceUrl === instanceUrl && record.webClipperSupported === true;
}

/** The cached version for this instance URL, or null when absent or recorded for a different URL. */
export async function readCachedVersion(instanceUrl: string): Promise<string | null> {
  const got = await browser.storage.local.get(VERSION_CACHE_KEY);
  const rec = got[VERSION_CACHE_KEY] as CachedVersion | undefined;
  return rec && rec.instanceUrl === instanceUrl && rec.version ? rec.version : null;
}

/** Records a version already fetched elsewhere (e.g. connect's verification) without re-fetching. */
export async function writeCachedVersion(instanceUrl: string, version: string, webClipperSupported?: boolean): Promise<void> {
  const rec: CachedVersion = { instanceUrl, version, ...(webClipperSupported ? { webClipperSupported: true } : {}) };
  await browser.storage.local.set({ [VERSION_CACHE_KEY]: rec });
}

/** Forgets the cached version (used on disconnect). */
export async function clearCachedVersion(): Promise<void> {
  await browser.storage.local.remove(VERSION_CACHE_KEY);
}

/**
 * The instance version, self-populating: returns the cache when present, otherwise fetches the
 * live `/instance/profile` and caches it. Pass `refresh` to force a re-fetch (connect / options
 * reload). Falls back to the cache on a transient fetch failure, and null when nothing is known.
 */
export async function resolveVersion(
  creds: MemosCredentials,
  opts: { refresh?: boolean } = {},
  deps?: InstanceFetchDeps,
): Promise<string | null> {
  return (await checkVersion(creds, opts, deps)).version;
}

export type VersionCheckResult = {
  version: string | null;
  /** Set when the live check failed. A cached version may still be present. */
  errorKind: InstanceErrorKind | null;
  fromCache: boolean;
  webClipperSupported?: boolean;
};

/**
 * The options page needs to distinguish "old version" from "could not verify". Keep
 * resolveVersion's compact cache-fallback contract for save gates, and expose this richer
 * result for settings UI and recovery behavior.
 */
export async function checkVersion(
  creds: MemosCredentials,
  opts: { refresh?: boolean } = {},
  deps?: InstanceFetchDeps,
): Promise<VersionCheckResult> {
  if (!opts.refresh) {
    const cached = await readCachedVersion(creds.instanceUrl);
    if (cached)
      return {
        version: cached,
        errorKind: null,
        fromCache: true,
        ...((await cachedCapability(creds.instanceUrl)) ? { webClipperSupported: true } : {}),
      };
  }
  try {
    const { version, webClipperSupported } = await getInstanceProfile(creds, deps);
    if (version) await writeCachedVersion(creds.instanceUrl, version, webClipperSupported);
    return { version: version || null, errorKind: null, fromCache: false, ...(webClipperSupported ? { webClipperSupported: true } : {}) };
  } catch (error) {
    const cached = await readCachedVersion(creds.instanceUrl);
    return {
      version: cached,
      errorKind: error instanceof InstanceError ? error.kind : "bad-response",
      fromCache: Boolean(cached),
      ...((await cachedCapability(creds.instanceUrl)) ? { webClipperSupported: true } : {}),
    };
  }
}
