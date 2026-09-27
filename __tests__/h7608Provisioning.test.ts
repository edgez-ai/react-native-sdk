import {H7608ProvisioningDevice} from '../src/H7608Provisioning';
import type {EdgezPlatformTransport} from '../src/EdgezMeshSdk';
import {EdgezProvisioningManager, type EdgezProvisioningConfig, type EdgezProvisioningDevice} from '../src/Provisioning';

jest.mock('react-native-ble-plx', () => ({BleManager: jest.fn()}));
jest.mock('@orbital-systems/react-native-esp-idf-provisioning', () => ({}));

function encode(value: string | number[]): string {
  return Buffer.from(typeof value === 'string' ? value : Uint8Array.from(value)).toString('base64');
}

function varint(value: bigint): number[] {
  const bytes: number[] = [];
  do { const byte = Number(value & 0x7fn); value >>= 7n; bytes.push(byte | (value ? 0x80 : 0)); } while (value);
  return bytes;
}

function bytesField(number: number, value: number[]): number[] {
  return [...varint(BigInt(number * 8 + 2)), ...varint(BigInt(value.length)), ...value];
}

class FakeTransport implements EdgezPlatformTransport {
  calls: Array<{method: string; arguments_?: Record<string, unknown>}> = [];

  async invoke<T>(method: string, arguments_?: Record<string, unknown>): Promise<T> {
    this.calls.push({method, arguments_});
    if (method === 'scanH7608ProvisioningNetworks') {
      return [{ssid: 'PROV_AABBCCDDEEFF', bssid: '00:11:22:33:44:55', rssi: -42, secure: true}] as T;
    }
    if (method === 'requestH7608Provisioning') {
      const path = arguments_?.path;
      if (path === '/proto-ver') return encode(JSON.stringify({prov: {ver: 'v1.1', sec_ver: 0, cap: ['wifi_scan', 'no_pop', 'edgez_h7608'], model: 'HT-H7608-V1', serial: 'AABBCCDDEEFF', configured: false}})) as T;
      if (path === '/prov-session') return encode([0x52, 0x05, 0x08, 0x01, 0xaa, 0x01, 0x00]) as T;
      if (path === '/prov-scan') {
        const scanCall = this.calls.filter(call => call.arguments_?.path === '/prov-scan').length;
        if (scanCall === 1) return encode([0x08, 0x01, 0x5a, 0x00]) as T;
        if (scanCall === 2) return encode([0x08, 0x03, 0x6a, 0x04, 0x08, 0x01, 0x10, 0x01]) as T;
        const ssid = [...Buffer.from('Farm WiFi')];
        const rssi = varint((1n << 64n) - 51n);
        const entry = [...bytesField(1, ssid), 0x18, ...rssi, ...bytesField(4, [0x11, 0x22, 0x33, 0x44, 0x55, 0x66]), 0x28, 0x03];
        const results = bytesField(1, entry);
        return encode([0x08, 0x05, ...bytesField(15, results)]) as T;
      }
      if (path === '/prov-config') {
        const request = Buffer.from(String(arguments_?.bodyBase64), 'base64');
        if (request[1] === 0x02) return encode([0x08, 0x03, 0x6a, 0x00]) as T;
        if (request[1] === 0x04) return encode([0x08, 0x05, 0x7a, 0x00]) as T;
        return encode([0x08, 0x01, 0x5a, 0x02, 0x5a, 0x00]) as T;
      }
      if (path === '/mqtt-config') return encode(JSON.stringify({ok: true, persisted: true})) as T;
    }
    return undefined as T;
  }

  subscribe(): () => void { return () => undefined; }
}

describe('H7608 SoftAP provisioning', () => {
  it('pins all device requests to the native local-network transport', async () => {
    const transport = new FakeTransport();
    const [device] = await H7608ProvisioningDevice.scan(transport);
    expect(device?.name).toBe('PROV_AABBCCDDEEFF');

    await expect(device!.connect('abcd1234')).resolves.toMatchObject({serial: 'AABBCCDDEEFF'});
    await expect(device!.scanUpstreamWifi('abcd1234')).resolves.toEqual([
      {ssid: 'Farm WiFi', bssid: '11:22:33:44:55:66', rssi: -51, secure: true},
    ]);
    await expect(device!.provisionUpstreamWifi('Farm WiFi', 'secret12', 'abcd1234')).resolves.toEqual({ok: true, persisted: true});
    await expect(device!.configure({
      clientId: 'client-1', username: 'AABBCCDDEEFF', password: 'secret', projectId: 'project-1',
      channel: 'live', meshId: 'farm-mesh', passphrase: 'mesh-secret', country: 'US',
      halowChannel: 27, softapSsid: 'Barn Gateway',
    }, 'abcd1234')).resolves.toEqual({ok: true, persisted: true});
    await device!.disconnect();

    expect(transport.calls.map(call => call.method)).toEqual([
      'scanH7608ProvisioningNetworks',
      'connectH7608ProvisioningNetwork',
      'requestH7608Provisioning',
      'requestH7608Provisioning',
      'requestH7608Provisioning',
      'requestH7608Provisioning',
      'requestH7608Provisioning',
      'requestH7608Provisioning',
      'requestH7608Provisioning',
      'requestH7608Provisioning',
      'requestH7608Provisioning',
      'disconnectH7608ProvisioningNetwork',
    ]);
    expect(transport.calls[10]?.arguments_).toMatchObject({
      method: 'POST', path: '/mqtt-config', responseBase64: true,
      bodyBase64: expect.any(String),
    });
    expect(Buffer.from(String(transport.calls[10]?.arguments_?.bodyBase64), 'base64').toString()).toContain('"softapSsid":"Barn Gateway"');
  });

  it('keeps device-specific config shaping inside the SDK', async () => {
    let received: EdgezProvisioningConfig | undefined;
    const device: EdgezProvisioningDevice = {
      kind: 'nrf54', id: 'nrf-1', name: 'NRF_AABBCCDDEEFF', serial: 'AABBCCDDEEFF',
      transport: 'ble', category: 'tracker', firmwareTarget: 'nrf54l15',
      requiresProofOfPossession: false, requiresDeviceName: false, deviceNameMaxLength: 128,
      supportsUpstreamWifi: false, supportsDeviceGps: true,
      connect: async () => undefined,
      configure: async config => { received = config; return {ok: true, persisted: true}; },
      scanUpstreamWifi: async () => [],
      provisionUpstreamWifi: async () => undefined,
      disconnect: async () => undefined,
    };
    await new EdgezProvisioningManager().configure(device, {
      clientId: 'client-1', username: device.serial, password: 'secret', projectId: 'project-1',
      channel: 'status', meshId: 'farm-mesh', passphrase: 'mesh-secret', country: 'US',
      halowChannel: 27, wifiUpstream: false, deviceName: 'Long 🐄 tracker name', useDeviceGps: true,
    });
    expect(received).toMatchObject({
      halowFrequencyKHz: 915500,
      deviceName: 'Long 🐄 tracker name',
      useDeviceGps: true,
    });
    expect(received).not.toHaveProperty('softapSsid');
  });
});
