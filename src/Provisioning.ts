import {fromByteArray, toByteArray} from 'base64-js';
import {PermissionsAndroid, Platform, type Permission} from 'react-native';
import {BleManager, type Device as BleDevice} from 'react-native-ble-plx';
import {
  ESPDevice,
  ESPProvisionManager,
  ESPSecurity,
  ESPTransport,
} from '@orbital-systems/react-native-esp-idf-provisioning';
import {EdgezNativeTransport} from './EdgezMeshSdk';

export type EdgezProvisioningKind = 'esp32' | 'nrf54' | 'h7608';
export type EdgezProvisioningTransport = 'ble' | 'softap';
export type EdgezProvisioningDeviceCategory = 'tracker' | 'gateway';
export interface EdgezProvisioningWifiNetwork {
  ssid: string;
  bssid?: string;
  rssi: number;
  auth?: number;
  secure?: boolean;
}
export interface EdgezProvisioningConfig {
  clientId: string;
  username: string;
  password: string;
  projectId: string;
  channel: string;
  meshId: string;
  passphrase: string;
  country: string;
  halowChannel: number;
  softapSsid?: string;
  softapPassword?: string;
  latitude?: number | null;
  longitude?: number | null;
  halowFrequencyKHz?: number;
  deviceName?: string;
  useDeviceGps?: boolean;
  wifiUpstream?: boolean;
}

export type EdgezProvisioningInput = Omit<EdgezProvisioningConfig,
  'halowFrequencyKHz' | 'softapSsid'> & {
  deviceName?: string;
  useDeviceGps?: boolean;
};

export interface EdgezProvisioningResult {
  ok?: boolean;
  persisted?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface EdgezProvisioningDevice {
  readonly kind: EdgezProvisioningKind;
  readonly id: string;
  readonly name: string;
  readonly serial: string;
  readonly transport: EdgezProvisioningTransport;
  readonly category: EdgezProvisioningDeviceCategory;
  readonly firmwareTarget: string;
  readonly requiresProofOfPossession: boolean;
  readonly requiresDeviceName: boolean;
  readonly deviceNameMaxLength: number;
  readonly supportsUpstreamWifi: boolean;
  readonly supportsDeviceGps: boolean;
  connect(pop?: string): Promise<void>;
  configure(config: EdgezProvisioningConfig): Promise<EdgezProvisioningResult>;
  scanUpstreamWifi(): Promise<EdgezProvisioningWifiNetwork[]>;
  provisionUpstreamWifi(ssid: string, passphrase: string): Promise<void>;
  disconnect(): Promise<void>;
}

export interface EdgezProvisioningScanResult {
  devices: EdgezProvisioningDevice[];
  warnings: string[];
}

function isEmptyProvisioningScan(error: unknown): boolean {
  return /no (?:bluetooth|wi-?fi) device found with given prefix/i.test(String(error));
}

function serialFromName(name: string): string {
  const match = /^(?:PROV|NRF)_([A-F0-9]{12})$/i.exec(name);
  if (!match) throw new Error(`Invalid provisioning name: ${name}`);
  return match[1]!.toUpperCase();
}

class EspIdfProvisioningDevice implements EdgezProvisioningDevice {
  readonly kind: 'esp32' | 'h7608';
  readonly transport: 'ble' | 'softap';
  readonly category = 'gateway' as const;
  readonly firmwareTarget: 'heltec-hc33' | 'heltec-h7608-v1';
  readonly requiresProofOfPossession = true;
  readonly requiresDeviceName: boolean;
  readonly deviceNameMaxLength: number;
  readonly supportsUpstreamWifi = true;
  readonly supportsDeviceGps = false;
  readonly id: string;
  readonly name: string;
  readonly serial: string;

  constructor(private readonly device: ESPDevice) {
    const softap = device.transport === ESPTransport.softap;
    this.kind = softap ? 'h7608' : 'esp32';
    this.transport = softap ? 'softap' : 'ble';
    this.firmwareTarget = softap ? 'heltec-h7608-v1' : 'heltec-hc33';
    this.requiresDeviceName = softap;
    this.deviceNameMaxLength = softap ? 32 : 128;
    this.id = device.name;
    this.name = device.name;
    this.serial = serialFromName(device.name);
  }

  async connect(pop?: string): Promise<void> {
    const secret = pop?.trim();
    if (!secret) throw new Error(`A provisioning password is required for the ${this.kind === 'h7608' ? 'H7608' : 'ESP32'}`);
    if (this.kind === 'h7608') await this.device.connect(null, secret, null);
    else await this.device.connect(secret, null, null);
  }

  async configure(config: EdgezProvisioningConfig): Promise<EdgezProvisioningResult> {
    const payload = JSON.stringify(config);
    const response = this.kind === 'h7608' && Platform.OS === 'android'
      ? await new EdgezNativeTransport().invoke<string>('sendH7608CustomEndpoint', {endpoint: 'mqtt-config', data: payload})
      : await this.device.sendData('mqtt-config', payload);
    const result = JSON.parse(response) as EdgezProvisioningResult;
    return {...result, persisted: result.persisted ?? result.ok};
  }

  scanUpstreamWifi(): Promise<EdgezProvisioningWifiNetwork[]> { return this.device.scanWifiList(); }
  async provisionUpstreamWifi(ssid: string, passphrase: string): Promise<void> { await this.device.provision(ssid, passphrase); }
  async disconnect(): Promise<void> { this.device.disconnect(); }
}

const nrfServiceUuid = 'a3631000-b82e-44c2-9b1d-a790675b4ac1';
const nrfConfigUuid = 'a3631001-b82e-44c2-9b1d-a790675b4ac1';
const nrfStatusUuid = 'a3631002-b82e-44c2-9b1d-a790675b4ac1';
let nrfManager: BleManager | null = null;
function bleManager(): BleManager { nrfManager ??= new BleManager(); return nrfManager; }

function utf8Bytes(value: string): Uint8Array {
  const encoded = encodeURIComponent(value);
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === '%') { bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(encoded.charCodeAt(i));
  }
  return Uint8Array.from(bytes);
}

function decodedStatus(value?: string | null): string | null {
  return value ? String.fromCharCode(...toByteArray(value)) : null;
}

function matchingConfirmation(value: string | null, confirmationId: string): EdgezProvisioningResult | null {
  if (!value) return null;
  try {
    const status = JSON.parse(value) as EdgezProvisioningResult & {confirmationId?: string; pending?: boolean};
    return status.confirmationId === confirmationId && !status.pending ? status : null;
  } catch { return null; }
}

class Nrf54ProvisioningDevice implements EdgezProvisioningDevice {
  readonly kind = 'nrf54' as const;
  readonly transport = 'ble' as const;
  readonly category = 'tracker' as const;
  readonly firmwareTarget = 'nrf54l15';
  readonly requiresProofOfPossession = false;
  readonly requiresDeviceName = false;
  readonly deviceNameMaxLength = 128;
  readonly supportsUpstreamWifi = false;
  readonly supportsDeviceGps = true;
  readonly serial: string;
  private connected: BleDevice | null = null;

  constructor(readonly id: string, readonly name: string) { this.serial = serialFromName(name); }

  async connect(): Promise<void> {
    this.connected = await bleManager().connectToDevice(this.id, {autoConnect: false});
    await this.connected.discoverAllServicesAndCharacteristics();
    try { this.connected = await this.connected.requestMTU(247); } catch { /* Default ATT MTU is supported. */ }
  }

  async configure(config: EdgezProvisioningConfig): Promise<EdgezProvisioningResult> {
    const device = this.connected;
    if (!device) throw new Error('The nRF54 is not connected');
    const confirmationId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    const payload = utf8Bytes(JSON.stringify({...config, confirmationId}));
    if (!payload.length || payload.length > 1024) throw new Error('Device configuration exceeds the BLE limit');
    let notified: EdgezProvisioningResult | null = null;
    const subscription = device.monitorCharacteristicForService(nrfServiceUuid, nrfStatusUuid, (error, characteristic) => {
      if (!error) notified = matchingConfirmation(decodedStatus(characteristic?.value), confirmationId);
    });
    const chunkSize = Math.max(1, Math.min(160, (device.mtu || 23) - 6));
    try {
      for (let offset = 0; offset < payload.length;) {
        const count = Math.min(payload.length - offset, chunkSize);
        const header = offset === 0 ? [1, payload.length & 255, payload.length >> 8] : [2];
        await device.writeCharacteristicWithResponseForService(
          nrfServiceUuid, nrfConfigUuid,
          fromByteArray(Uint8Array.from([...header, ...payload.slice(offset, offset + count)])),
        );
        offset += count;
      }
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (notified) return notified;
        const status = await device.readCharacteristicForService(nrfServiceUuid, nrfStatusUuid);
        const confirmed = matchingConfirmation(decodedStatus(status.value), confirmationId);
        if (confirmed) return confirmed;
        await new Promise<void>(resolve => setTimeout(() => resolve(), 250));
      }
      throw new Error('The nRF54 did not confirm persisted configuration within 10 seconds');
    } finally { subscription.remove(); }
  }

  async scanUpstreamWifi(): Promise<EdgezProvisioningWifiNetwork[]> { return []; }
  async provisionUpstreamWifi(): Promise<void> { throw new Error('The nRF54 does not support upstream Wi-Fi'); }
  async disconnect(): Promise<void> {
    const device = this.connected; this.connected = null;
    if (device) await bleManager().cancelDeviceConnection(device.id).catch(() => undefined);
  }
}

async function scanNrf54(): Promise<Nrf54ProvisioningDevice[]> {
  const found = new Map<string, Nrf54ProvisioningDevice>();
  const manager = bleManager();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { manager.stopDeviceScan(); resolve(); }, 6000);
    manager.startDeviceScan(null, {allowDuplicates: false}, (error, device) => {
      if (error) { clearTimeout(timer); manager.stopDeviceScan(); reject(error); return; }
      const name = device?.name || device?.localName;
      const hasService = device?.serviceUUIDs?.some(uuid => /^(?:0000)?fff0(?:-0000-1000-8000-00805f9b34fb)?$/i.test(uuid));
      if (device && name && (/^NRF_[A-F0-9]{12}$/i.test(name) || (/^PROV_[A-F0-9]{12}$/i.test(name) && hasService))) {
        found.set(device.id, new Nrf54ProvisioningDevice(device.id, name));
      }
    });
  });
  return [...found.values()];
}

export class EdgezProvisioningManager {
  async scan(): Promise<EdgezProvisioningScanResult> {
    await requestProvisioningPermissions();
    const warnings: string[] = [];
    let nrf: Nrf54ProvisioningDevice[] = [];
    try { nrf = await scanNrf54(); } catch (error) { warnings.push(`nRF54 scan: ${String(error)}`); }
    const nrfNames = new Set(nrf.map(device => device.name.toLowerCase()));
    let esp: EspIdfProvisioningDevice[] = [];
    try {
      esp = (await ESPProvisionManager.searchESPDevices('PROV_', ESPTransport.ble, ESPSecurity.secure))
        .filter(device => /^PROV_[A-F0-9]{12}$/i.test(device.name) && !nrfNames.has(device.name.toLowerCase()))
        .map(device => new EspIdfProvisioningDevice(device));
    } catch (error) {
      if (!isEmptyProvisioningScan(error)) warnings.push(`ESP32 BLE scan: ${String(error)}`);
    }
    let h7608: EspIdfProvisioningDevice[] = [];
    try {
      const discovered = await ESPProvisionManager.searchESPDevices('PROV_', ESPTransport.softap, ESPSecurity.unsecure);
      h7608 = discovered.filter(device => /^PROV_[A-F0-9]{12}$/i.test(device.name)).map(device =>
        new EspIdfProvisioningDevice(new ESPDevice({
          name: device.name,
          transport: ESPTransport.softap,
          security: ESPSecurity.unsecure,
        })),
      );
    } catch (error) {
      if (!isEmptyProvisioningScan(error)) warnings.push(`ESP-IDF SoftAP scan: ${String(error)}`);
    }

    return {devices: [...esp, ...nrf, ...h7608], warnings};
  }

  connect(device: EdgezProvisioningDevice, pop?: string): Promise<void> {
    return device.connect(pop);
  }

  async configure(
    device: EdgezProvisioningDevice,
    input: EdgezProvisioningInput,
    upstreamWifi?: {ssid: string; passphrase: string},
  ): Promise<EdgezProvisioningResult> {
    const config = provisioningConfig(device, input);
    if (device.kind === 'h7608' && upstreamWifi) {
      await device.provisionUpstreamWifi(upstreamWifi.ssid, upstreamWifi.passphrase);
    }
    const result = await device.configure(config);
    if (!result.ok || !result.persisted) throw new Error(result.error || 'The device did not confirm persisted configuration');
    if (device.kind !== 'h7608' && upstreamWifi) await device.provisionUpstreamWifi(upstreamWifi.ssid, upstreamWifi.passphrase);
    return result;
  }

  scanUpstreamWifi(device: EdgezProvisioningDevice): Promise<EdgezProvisioningWifiNetwork[]> {
    return device.scanUpstreamWifi();
  }

  disconnect(device?: EdgezProvisioningDevice | null): Promise<void> {
    return device ? device.disconnect() : Promise.resolve();
  }
}

function provisioningConfig(
  device: EdgezProvisioningDevice,
  input: EdgezProvisioningInput,
): EdgezProvisioningConfig {
  const deviceName = input.deviceName?.trim() || '';
  if (device.requiresDeviceName && !deviceName) {
    throw new Error('A device name is required');
  }
  if (deviceName.length > device.deviceNameMaxLength) {
    throw new Error(`Device name must not exceed ${device.deviceNameMaxLength} characters`);
  }
  if (device.kind === 'h7608' && utf8Bytes(deviceName).length > device.deviceNameMaxLength) {
    throw new Error(`Device name must not exceed ${device.deviceNameMaxLength} UTF-8 bytes`);
  }
  if (device.kind === 'h7608' && !/^[\x20-\x7e]{8,63}$/.test(input.softapPassword || '')) {
    throw new Error('Device Wi-Fi password must be 8 to 63 printable ASCII characters');
  }
  const config: EdgezProvisioningConfig = {
    clientId: input.clientId,
    username: input.username,
    password: input.password,
    projectId: input.projectId,
    channel: input.channel,
    meshId: input.meshId,
    passphrase: input.passphrase,
    country: input.country,
    halowChannel: input.halowChannel,
    wifiUpstream: input.wifiUpstream,
    latitude: input.latitude,
    longitude: input.longitude,
  };
  if (device.kind === 'h7608') {
    config.softapSsid = deviceName;
    config.softapPassword = input.softapPassword;
  }
  if (device.kind === 'nrf54') {
    config.halowFrequencyKHz = halowFrequencyKHz(input.country, input.halowChannel);
    config.deviceName = utf8LimitedName(deviceName || device.serial, 64);
    config.useDeviceGps = input.useDeviceGps === true;
    if (config.useDeviceGps && input.latitude == null && input.longitude == null) {
      delete config.latitude;
      delete config.longitude;
    }
  }
  return config;
}

function halowFrequencyKHz(country: string, channel: number): number {
  const code = country.toUpperCase();
  let baseMHz: number;
  if (['AU', 'CA', 'NZ', 'US'].includes(code)) baseMHz = 902;
  else if (code === 'EU' || code === 'IN' || (code === 'GB' && channel <= 9)) baseMHz = 863;
  else if (code === 'GB') baseMHz = 901.4;
  else if (code === 'JP') baseMHz = 916.5;
  else if (code === 'KR') baseMHz = 917.5;
  else throw new Error(`Unsupported HaLow country: ${country}`);
  return Math.round((baseMHz + channel / 2) * 1000);
}

function utf8LimitedName(value: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const count = utf8Bytes(character).length;
    if (bytes + count > maxBytes) break;
    result += character;
    bytes += count;
  }
  return result;
}

async function requestProvisioningPermissions(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const permissions: Permission[] = Number(Platform.Version) >= 33
    ? [
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES,
      ]
    : Number(Platform.Version) >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const missing: Permission[] = [];
  for (const permission of permissions) if (!await PermissionsAndroid.check(permission)) missing.push(permission);
  if (!missing.length) return;
  const results = await PermissionsAndroid.requestMultiple(missing);
  if (missing.some(permission => results[permission] !== PermissionsAndroid.RESULTS.GRANTED)) {
    throw new Error('Bluetooth and nearby Wi-Fi permissions are required to discover provisioning devices');
  }
}
