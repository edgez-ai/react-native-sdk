import {NativeModules, Platform} from 'react-native';

export interface EdgezAppBundleManifest {
  schemaVersion: 1;
  platform: 'android';
  updateId: string;
  runtimeVersion: string;
  releaseTag: string;
  bundleAssetName: string;
  sha256: string;
  size: number;
  createdAt: string;
  signedPayload: string;
  signature: string;
}

export interface EdgezAppBundleUpdateStatus {
  runtimeVersion?: string;
  updateId?: string;
  sha256?: string;
  rejectedUpdateId?: string;
  installed: boolean;
  healthy: boolean;
  pendingRestart: boolean;
}

export interface EdgezAppBundleUpdateOptions {
  repositoryUrl: string;
  otaBaseUrl?: string;
  manifestAssetName?: string;
}

export interface EdgezAppBundleUpdateResult {
  state: 'unsupported' | 'current' | 'incompatible' | 'rejected' | 'available' | 'installed';
  manifest?: EdgezAppBundleManifest;
  status?: EdgezAppBundleUpdateStatus;
  bundleUrl?: string;
}

type NativeBundleModule = {
  getAppBundleUpdateStatus(arguments_: Record<string, never>): Promise<EdgezAppBundleUpdateStatus>;
  installAppBundleUpdate(arguments_: Record<string, unknown>): Promise<EdgezAppBundleUpdateStatus>;
  markAppBundleUpdateHealthy(arguments_: Record<string, never>): Promise<EdgezAppBundleUpdateStatus>;
  rollbackAppBundleUpdate(arguments_: Record<string, never>): Promise<EdgezAppBundleUpdateStatus>;
};

function nativeBundleModule(): NativeBundleModule {
  const native = NativeModules.EdgezReactNativeSdk as NativeBundleModule | undefined;
  if (!native) throw new Error('@edgez/react-native-sdk is not linked');
  return native;
}

function repositoryParts(repositoryUrl: string): {owner: string; repository: string} {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(repositoryUrl);
  if (!match) throw new Error('App bundle repository must be a public GitHub HTTPS URL');
  return {owner: match[1]!, repository: match[2]!};
}

function safeAsset(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+$/.test(value);
}

function decodeBase64Utf8(encoded: string): string {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Invalid base64 encoding');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes: number[] = [];
  let bits = 0;
  let bitCount = 0;
  for (const character of encoded.replace(/=+$/, '')) {
    bits = (bits << 6) | alphabet.indexOf(character);
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bits >> bitCount) & 0xff);
      bits &= (1 << bitCount) - 1;
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

export function parseAppBundleManifest(value: unknown): EdgezAppBundleManifest {
  const envelope = value as {schemaVersion?: unknown; signedPayload?: unknown; signature?: unknown} | null;
  if (!envelope || envelope.schemaVersion !== 1 || typeof envelope.signedPayload !== 'string' || typeof envelope.signature !== 'string') {
    throw new Error('Unsupported signed app bundle manifest');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(decodeBase64Utf8(envelope.signedPayload)); } catch { throw new Error('Invalid signed app bundle payload'); }
  const manifest = parsed as Partial<EdgezAppBundleManifest> | null;
  if (!manifest || manifest.schemaVersion !== 1 || manifest.platform !== 'android') throw new Error('Unsupported app bundle manifest');
  if (typeof manifest.updateId !== 'string' || !manifest.updateId || manifest.updateId.length > 256) throw new Error('Invalid app bundle update ID');
  if (typeof manifest.runtimeVersion !== 'string' || !manifest.runtimeVersion || manifest.runtimeVersion.length > 128) throw new Error('Invalid app bundle runtime');
  if (typeof manifest.releaseTag !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(manifest.releaseTag)) throw new Error('Invalid app bundle release tag');
  if (!safeAsset(manifest.bundleAssetName)) throw new Error('Invalid app bundle asset name');
  if (typeof manifest.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(manifest.sha256)) throw new Error('Invalid app bundle SHA-256');
  if (typeof manifest.size !== 'number' || !Number.isSafeInteger(manifest.size) || manifest.size <= 0 || manifest.size > 64 * 1024 * 1024) throw new Error('Invalid app bundle size');
  if (typeof manifest.createdAt !== 'string' || Number.isNaN(Date.parse(manifest.createdAt))) throw new Error('Invalid app bundle creation time');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature)) throw new Error('Invalid app bundle signature');
  return {...manifest, sha256: manifest.sha256.toLowerCase(), signedPayload: envelope.signedPayload, signature: envelope.signature} as EdgezAppBundleManifest;
}

export async function getAppBundleUpdateStatus(): Promise<EdgezAppBundleUpdateStatus> {
  if (Platform.OS !== 'android') return {installed: false, healthy: false, pendingRestart: false};
  return nativeBundleModule().getAppBundleUpdateStatus({});
}

export async function installAppBundleUpdate(manifest: EdgezAppBundleManifest, bundleUrl: string): Promise<EdgezAppBundleUpdateStatus> {
  if (Platform.OS !== 'android') throw new Error('React Native bundle updates currently require Android');
  return nativeBundleModule().installAppBundleUpdate({
    bundleUrl,
    signedPayload: manifest.signedPayload,
    signature: manifest.signature,
  });
}

export async function markAppBundleUpdateHealthy(): Promise<EdgezAppBundleUpdateStatus> {
  if (Platform.OS !== 'android') return {installed: false, healthy: false, pendingRestart: false};
  return nativeBundleModule().markAppBundleUpdateHealthy({});
}

export async function rollbackAppBundleUpdate(): Promise<EdgezAppBundleUpdateStatus> {
  if (Platform.OS !== 'android') return {installed: false, healthy: false, pendingRestart: false};
  return nativeBundleModule().rollbackAppBundleUpdate({});
}

/**
 * Uses the same constrained release proxy as device firmware OTA. The bundle
 * is installed into the Android app's private storage and is never sent to a
 * connected device. It becomes active on the next app process start.
 */
export async function checkAppBundleUpdate(options: EdgezAppBundleUpdateOptions): Promise<EdgezAppBundleUpdateResult> {
  if (Platform.OS !== 'android') return {state: 'unsupported'};
  const {owner, repository} = repositoryParts(options.repositoryUrl);
  const base = (options.otaBaseUrl ?? 'https://github.edgez.biz').replace(/\/$/, '');
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(base)) throw new Error('App bundle OTA base URL must use HTTPS');
  const manifestName = options.manifestAssetName ?? 'live-stocking-update.json';
  if (!safeAsset(manifestName)) throw new Error('Invalid app bundle manifest asset name');
  const prefix = `${base}/${owner}/${repository}/releases`;
  const response = await fetch(`${prefix}/latest/download/${manifestName}`, {headers: {Accept: 'application/json'}});
  if (!response.ok) throw new Error(`App bundle manifest download failed with HTTP ${response.status}`);
  const manifest = parseAppBundleManifest(await response.json());
  const status = await getAppBundleUpdateStatus();
  if (manifest.runtimeVersion !== status.runtimeVersion) return {state: 'incompatible', manifest, status};
  if (manifest.updateId === status.rejectedUpdateId) return {state: 'rejected', manifest, status};
  if (manifest.updateId === status.updateId && status.installed) return {state: 'current', manifest, status};
  const bundleUrl = `${prefix}/download/${encodeURIComponent(manifest.releaseTag)}/${encodeURIComponent(manifest.bundleAssetName)}`;
  return {state: 'available', manifest, status, bundleUrl};
}

export async function checkAndInstallAppBundleUpdate(options: EdgezAppBundleUpdateOptions): Promise<EdgezAppBundleUpdateResult> {
  const result = await checkAppBundleUpdate(options);
  if (result.state !== 'available' || !result.manifest || !result.bundleUrl) return result;
  return {
    state: 'installed',
    manifest: result.manifest,
    bundleUrl: result.bundleUrl,
    status: await installAppBundleUpdate(result.manifest, result.bundleUrl),
  };
}
