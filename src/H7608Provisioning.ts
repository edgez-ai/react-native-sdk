import {fromByteArray, toByteArray} from 'base64-js';
import {EdgezNativeTransport, type EdgezPlatformTransport} from './EdgezMeshSdk';

export interface H7608ProvisioningNetwork { ssid: string; bssid: string; rssi: number; secure: boolean; }
export interface H7608ProvisioningInfo { ok: boolean; model: 'HT-H7608-V1'; serial: string; configured: boolean; }
export interface H7608ProvisioningConfig {
  clientId: string; username: string; password: string; projectId: string; channel: string;
  meshId: string; passphrase: string; country: string; halowChannel: number; softapSsid?: string;
  latitude?: number | null; longitude?: number | null;
}
export interface H7608UpstreamNetwork { ssid: string; bssid?: string; rssi: number; secure: boolean; }

type ProtoField = {number: number; wire: number; value: bigint | Uint8Array};

function utf8(value: string): Uint8Array {
  const encoded = encodeURIComponent(value);
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index++) {
    if (encoded[index] === '%') { bytes.push(parseInt(encoded.slice(index + 1, index + 3), 16)); index += 2; }
    else bytes.push(encoded.charCodeAt(index));
  }
  return Uint8Array.from(bytes);
}

function utf8String(value: Uint8Array): string {
  return decodeURIComponent([...value].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join(''));
}

function varint(value: number | bigint): number[] {
  let remaining = BigInt(value);
  const bytes: number[] = [];
  do {
    const byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    bytes.push(byte | (remaining ? 0x80 : 0));
  } while (remaining);
  return bytes;
}

function bytesField(number: number, value: Uint8Array | number[]): number[] {
  return [...varint(number * 8 + 2), ...varint(value.length), ...value];
}
function uintField(number: number, value: number): number[] { return [...varint(number * 8), ...varint(value)]; }

function fields(data: Uint8Array): ProtoField[] {
  const output: ProtoField[] = [];
  let offset = 0;
  const readVarint = (): bigint => {
    let value = 0n;
    let shift = 0n;
    while (offset < data.length) {
      const byte = data[offset++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return value;
      shift += 7n;
      if (shift > 70n) throw new Error('Invalid ESP provisioning protobuf');
    }
    throw new Error('Truncated ESP provisioning protobuf');
  };
  while (offset < data.length) {
    const tag = Number(readVarint());
    const number = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) output.push({number, wire, value: readVarint()});
    else if (wire === 2) {
      const length = Number(readVarint());
      if (offset + length > data.length) throw new Error('Truncated ESP provisioning protobuf');
      output.push({number, wire, value: data.slice(offset, offset + length)});
      offset += length;
    } else throw new Error(`Unsupported ESP provisioning protobuf wire type ${wire}`);
  }
  return output;
}

function bytesValue(values: ProtoField[], number: number): Uint8Array | undefined {
  const value = values.find(field => field.number === number && field.wire === 2)?.value;
  return value instanceof Uint8Array ? value : undefined;
}
function intValue(values: ProtoField[], number: number, fallback = 0): number {
  const value = values.find(field => field.number === number && field.wire === 0)?.value;
  return typeof value === 'bigint' ? Number(value) : fallback;
}
function int32Value(values: ProtoField[], number: number, fallback = 0): number {
  const value = values.find(field => field.number === number && field.wire === 0)?.value;
  return typeof value === 'bigint' ? Number(BigInt.asIntN(32, value)) : fallback;
}

export class H7608ProvisioningDevice {
  readonly kind = 'h7608' as const;
  private connected = false;

  constructor(readonly network: H7608ProvisioningNetwork, private readonly transport: EdgezPlatformTransport = new EdgezNativeTransport()) {}
  get name(): string { return this.network.ssid; }

  static async scan(transport: EdgezPlatformTransport = new EdgezNativeTransport()): Promise<H7608ProvisioningDevice[]> {
    const networks = await transport.invoke<H7608ProvisioningNetwork[]>('scanH7608ProvisioningNetworks');
    return networks.map(network => new H7608ProvisioningDevice(network, transport));
  }

  async connect(apPassword: string): Promise<H7608ProvisioningInfo> {
    await this.transport.invoke('connectH7608ProvisioningNetwork', {ssid: this.network.ssid, passphrase: apPassword});
    this.connected = true;
    try {
      const version = JSON.parse(utf8String(await this.request('/proto-ver', utf8('ESP')))) as {
        prov?: {sec_ver?: number; cap?: string[]; model?: string; serial?: string; configured?: boolean};
      };
      const advertisedSerial = this.network.ssid.slice('PROV_'.length).toUpperCase();
      if (version.prov?.sec_ver !== 0 || !version.prov.cap?.includes('edgez_h7608') ||
          version.prov.model !== 'HT-H7608-V1' || version.prov.serial !== advertisedSerial) {
        throw new Error('The connected SoftAP is not the selected H7608');
      }
      await this.request('/prov-session', Uint8Array.from([0x52, 0x03, 0xa2, 0x01, 0x00]));
      return {ok: true, model: 'HT-H7608-V1', serial: advertisedSerial, configured: version.prov.configured === true};
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async configure(config: H7608ProvisioningConfig, _apPassword: string): Promise<{ok: boolean; persisted?: boolean; error?: string}> {
    if (!this.connected) throw new Error('The H7608 SoftAP is not connected');
    return JSON.parse(utf8String(await this.request('/mqtt-config', utf8(JSON.stringify(config))))) as {ok: boolean; persisted?: boolean; error?: string};
  }

  async scanUpstreamWifi(_apPassword: string): Promise<H7608UpstreamNetwork[]> {
    await this.request('/prov-scan', Uint8Array.from([0x52, 0x06, 0x08, 0x01, 0x18, 0x05, 0x20, 0x78]));
    const status = fields(await this.request('/prov-scan', Uint8Array.from([0x08, 0x02, 0x62, 0x00])));
    const statusPayload = fields(bytesValue(status, 13) ?? new Uint8Array());
    const count = intValue(statusPayload, 2);
    if (!intValue(statusPayload, 1)) throw new Error('The H7608 upstream Wi-Fi scan did not finish');
    const resultCommand = Uint8Array.from([0x08, 0x04, ...bytesField(14, uintField(2, count))]);
    const result = fields(await this.request('/prov-scan', resultCommand));
    const resultPayload = fields(bytesValue(result, 15) ?? new Uint8Array());
    return resultPayload.filter(field => field.number === 1 && field.value instanceof Uint8Array).map(field => {
      const entry = fields(field.value as Uint8Array);
      const ssid = bytesValue(entry, 1);
      const bssid = bytesValue(entry, 4);
      return {
        ssid: ssid ? utf8String(ssid).replace(/\0+$/, '') : '',
        ...(bssid ? {bssid: [...bssid].map(byte => byte.toString(16).padStart(2, '0')).join(':')} : {}),
        rssi: int32Value(entry, 3, -127), secure: intValue(entry, 5) !== 0,
      };
    }).filter(network => Boolean(network.ssid));
  }

  async provisionUpstreamWifi(ssid: string, passphrase: string, _apPassword: string): Promise<{ok: boolean; persisted?: boolean; error?: string}> {
    const setConfig = Uint8Array.from([0x08, 0x02, ...bytesField(12, [
      ...bytesField(1, utf8(ssid)), ...bytesField(2, utf8(passphrase)),
    ])]);
    const setResponse = fields(await this.request('/prov-config', setConfig));
    if (intValue(setResponse, 1) !== 3) throw new Error('The H7608 rejected the upstream Wi-Fi settings');
    const applyResponse = fields(await this.request('/prov-config', Uint8Array.from([0x08, 0x04, 0x72, 0x00])));
    if (intValue(applyResponse, 1) !== 5) throw new Error('The H7608 could not persist upstream Wi-Fi');
    const statusResponse = fields(await this.request('/prov-config', Uint8Array.from([0x52, 0x00])));
    const status = fields(bytesValue(statusResponse, 11) ?? new Uint8Array());
    if (intValue(status, 2) !== 0) throw new Error('The H7608 upstream Wi-Fi configuration failed');
    return {ok: true, persisted: true};
  }

  async disconnect(): Promise<void> { this.connected = false; await this.transport.invoke('disconnectH7608ProvisioningNetwork'); }

  private async request(path: '/proto-ver' | '/prov-session' | '/prov-scan' | '/prov-config' | '/mqtt-config', body: Uint8Array): Promise<Uint8Array> {
    const response = await this.transport.invoke<string>('requestH7608Provisioning', {
      method: 'POST', path, bodyBase64: fromByteArray(body), responseBase64: true,
    });
    return toByteArray(response);
  }
}
