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
  state: 'unsupported' | 'current' | 'incompatible' | 'rejected' | 'installed';
  manifest?: EdgezAppBundleManifest;
  status?: EdgezAppBundleUpdateStatus;
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

export function parseAppBundleManifest(value: unknown): EdgezAppBundleManifest {
  const manifest = value as Partial<EdgezAppBundleManifest> | null;
  if (!manifest || manifest.schemaVersion !== 1 || manifest.platform !== 'android') throw new Error('Unsupported app bundle manifest');
  if (typeof manifest.updateId !== 'string' || !manifest.updateId || manifest.updateId.length > 256) throw new Error('Invalid app bundle update ID');
  if (typeof manifest.runtimeVersion !== 'string' || !manifest.runtimeVersion || manifest.runtimeVersion.length > 128) throw new Error('Invalid app bundle runtime');
  if (typeof manifest.releaseTag !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(manifest.releaseTag)) throw new Error('Invalid app bundle release tag');
  if (!safeAsset(manifest.bundleAssetName)) throw new Error('Invalid app bundle asset name');
  if (typeof manifest.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(manifest.sha256)) throw new Error('Invalid app bundle SHA-256');
  if (typeof manifest.size !== 'number' || !Number.isSafeInteger(manifest.size) || manifest.size <= 0 || manifest.size > 64 * 1024 * 1024) throw new Error('Invalid app bundle size');
  if (typeof manifest.createdAt !== 'string' || Number.isNaN(Date.parse(manifest.createdAt))) throw new Error('Invalid app bundle creation time');
  return {...manifest, sha256: manifest.sha256.toLowerCase()} as EdgezAppBundleManifest;
}

export async function getAppBundleUpdateStatus(): Promise<EdgezAppBundleUpdateStatus> {
  if (Platform.OS !== 'android') return {installed: false, healthy: false, pendingRestart: false};
  return nativeBundleModule().getAppBundleUpdateStatus({});
}

export async function installAppBundleUpdate(manifest: EdgezAppBundleManifest, bundleUrl: string): Promise<EdgezAppBundleUpdateStatus> {
  if (Platform.OS !== 'android') throw new Error('React Native bundle updates currently require Android');
  return nativeBundleModule().installAppBundleUpdate({
    updateId: manifest.updateId,
    runtimeVersion: manifest.runtimeVersion,
    bundleUrl,
    sha256: manifest.sha256,
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
export async function checkAndInstallAppBundleUpdate(options: EdgezAppBundleUpdateOptions): Promise<EdgezAppBundleUpdateResult> {
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
  return {state: 'installed', manifest, status: await installAppBundleUpdate(manifest, bundleUrl)};
}
