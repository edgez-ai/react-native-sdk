import AsyncStorage from '@react-native-async-storage/async-storage';
import {x25519} from '@noble/curves/ed25519';
import {randomBytes} from '@noble/hashes/utils';
import type {EdgezBleDevice, EdgezSensorConnector, EdgezSensorScriptConfig, EdgezUserIdentity} from './models';

const IDENTITY_KEY = '@edgez/identity/v1';
const BLE_KEY = '@edgez/ble-configuration/v1';
const DRIVERS_KEY = '@edgez/drivers/v1';

const encode64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));

function uuid(): string {
  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function uuidPart(value: string, start: number): bigint {
  return BigInt.asIntN(64, BigInt(`0x${value.replace(/-/g, '').slice(start, start + 16)}`));
}

function createIdentity(name: string): EdgezUserIdentity {
  const userUuid = uuid();
  const privateKey = x25519.utils.randomPrivateKey();
  return {userUuid, userIdHigh: uuidPart(userUuid, 0), userIdLow: uuidPart(userUuid, 16), name, privateKey, publicKey: x25519.getPublicKey(privateKey)};
}

export class EdgezIdentityStore {
  async getOrCreate(): Promise<EdgezUserIdentity> {
    const stored = await AsyncStorage.getItem(IDENTITY_KEY);
    if (stored) {
      try {
        const value = JSON.parse(stored) as Record<string, string>;
        const privateKey = decode64(value.privateKey ?? '');
        const publicKey = decode64(value.publicKey ?? '');
        if (privateKey.length === 32 && publicKey.length === 32 && value.userUuid) {
          return {userUuid: value.userUuid, userIdHigh: uuidPart(value.userUuid, 0), userIdLow: uuidPart(value.userUuid, 16), name: value.name || 'EdgeZ User', privateKey, publicKey};
        }
      } catch {}
    }
    const identity = createIdentity('EdgeZ User');
    await this.save(identity);
    return identity;
  }

  createIdentity(name = 'EdgeZ Device'): EdgezUserIdentity { return createIdentity(name.trim() || 'EdgeZ Device'); }
  async updateName(name: string): Promise<EdgezUserIdentity> { const identity = {...await this.getOrCreate(), name: name.trim() || 'EdgeZ User'}; await this.save(identity); return identity; }
  async regenerateKeyPair(): Promise<EdgezUserIdentity> { const current = await this.getOrCreate(); const privateKey = x25519.utils.randomPrivateKey(); const identity = {...current, privateKey, publicKey: x25519.getPublicKey(privateKey)}; await this.save(identity); return identity; }
  async save(identity: EdgezUserIdentity): Promise<void> { await AsyncStorage.setItem(IDENTITY_KEY, JSON.stringify({userUuid: identity.userUuid, name: identity.name, privateKey: encode64(identity.privateKey), publicKey: encode64(identity.publicKey)})); }
}

export interface EdgezBleConfiguration {
  deviceId: string; deviceName: string; autoConnect: boolean; shareLocation: boolean;
  countryCode: string; meshBandwidthMhz: number; meshFrequencyKhz: number;
}
const defaultBle: EdgezBleConfiguration = {
  deviceId: '', deviceName: '', autoConnect: false, shareLocation: false,
  countryCode: 'US', meshBandwidthMhz: 1, meshFrequencyKhz: 902500,
};

export class EdgezBleConfigurationStore {
  async load(): Promise<EdgezBleConfiguration> { try { return {...defaultBle, ...JSON.parse(await AsyncStorage.getItem(BLE_KEY) ?? '{}')}; } catch { return defaultBle; } }
  private async update(change: Partial<EdgezBleConfiguration>): Promise<void> { await AsyncStorage.setItem(BLE_KEY, JSON.stringify({...await this.load(), ...change})); }
  saveSelectedDevice(device: EdgezBleDevice): Promise<void> { return this.update({deviceId: device.id, deviceName: device.name}); }
  setAutoConnect(autoConnect: boolean): Promise<void> { return this.update({autoConnect}); }
  setShareLocation(shareLocation: boolean): Promise<void> { return this.update({shareLocation}); }
  setMeshRadio(countryCode: string, meshBandwidthMhz: number, meshFrequencyKhz: number): Promise<void> {
    return this.update({countryCode, meshBandwidthMhz, meshFrequencyKhz});
  }
  clearSelectedDevice(): Promise<void> { return this.update({deviceId: '', deviceName: ''}); }
}

export interface EdgezDriverBundle {
  driverId: string; key: string; scriptId: number; version: number; name: string;
  connector: EdgezSensorConnector; script: string; description?: string; globalBufferSize?: number;
  mimeType?: string; imageBase64?: string; marketplaceItemId?: string; marketplaceSlug?: string;
}

export function driverToScriptConfig(bundle: EdgezDriverBundle): EdgezSensorScriptConfig {
  return {scriptId: bundle.scriptId, version: bundle.version, name: bundle.name, sensorType: bundle.key, connector: bundle.connector, script: bundle.script, globalBufferSize: bundle.globalBufferSize ?? 4096, mimeType: bundle.mimeType ?? 'application/x-lua'};
}

export class EdgezDriverStore {
  async load(): Promise<ReadonlyArray<EdgezDriverBundle>> { try { const value = JSON.parse(await AsyncStorage.getItem(DRIVERS_KEY) ?? '[]') as EdgezDriverBundle[]; return value.sort((a,b) => a.name.localeCompare(b.name)); } catch { return []; } }
  async save(bundle: EdgezDriverBundle): Promise<EdgezDriverBundle> { this.validate(bundle); const current = [...await this.load()].filter(item => !(item.driverId === bundle.driverId && item.version === bundle.version)); current.push(bundle); await AsyncStorage.setItem(DRIVERS_KEY, JSON.stringify(current)); return bundle; }
  async remove(driverId: string, version?: number): Promise<void> { const current = [...await this.load()].filter(item => item.driverId !== driverId || (version !== undefined && item.version !== version)); await AsyncStorage.setItem(DRIVERS_KEY, JSON.stringify(current)); }
  private validate(bundle: EdgezDriverBundle): void { if (!/^[A-Za-z0-9._-]+$/.test(bundle.driverId) || !bundle.key.trim() || bundle.scriptId <= 0 || bundle.version <= 0 || !bundle.name.trim() || !bundle.script.trim()) throw new Error('Driver bundle is incomplete or invalid'); }
}
