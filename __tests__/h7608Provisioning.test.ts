import {H7608ProvisioningDevice} from '../src/H7608Provisioning';
import type {EdgezPlatformTransport} from '../src/EdgezMeshSdk';

class FakeTransport implements EdgezPlatformTransport {
  calls: Array<{method: string; arguments_?: Record<string, unknown>}> = [];

  async invoke<T>(method: string, arguments_?: Record<string, unknown>): Promise<T> {
    this.calls.push({method, arguments_});
    if (method === 'scanH7608ProvisioningNetworks') {
      return [{ssid: 'PROV_AABBCCDDEEFF', bssid: '00:11:22:33:44:55', rssi: -42, secure: true}] as T;
    }
    if (method === 'requestH7608Provisioning') {
      const path = arguments_?.path;
      if (path === '/info') return JSON.stringify({ok: true, model: 'HT-H7608-V1', serial: 'AABBCCDDEEFF', configured: false}) as T;
      if (path === '/upstream/scan') return JSON.stringify({results: [{ssid: 'Farm WiFi', bssid: '11:22:33:44:55:66', signal: -51, encryption: {enabled: true}}]}) as T;
      return JSON.stringify({ok: true, persisted: true}) as T;
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
      'disconnectH7608ProvisioningNetwork',
    ]);
    expect(transport.calls[4]?.arguments_).toMatchObject({
      method: 'POST', path: '/config', pop: 'abcd1234',
      body: expect.stringContaining('"softapSsid":"Barn Gateway"'),
    });
  });
});
