import {
  EdgezProvisioningManager,
  type EdgezProvisioningConfig,
  type EdgezProvisioningDevice,
} from '../src/Provisioning';
import * as EspProvisioning from '@orbital-systems/react-native-esp-idf-provisioning';

jest.mock('react-native-ble-plx', () => ({
  BleManager: jest.fn(() => ({startDeviceScan: jest.fn(), stopDeviceScan: jest.fn()})),
}));
jest.mock('@orbital-systems/react-native-esp-idf-provisioning', () => {
  const ESPTransport = {ble: 'ble', softap: 'softap'};
  const ESPSecurity = {unsecure: 0, secure: 1, secure2: 2};
  class ESPDevice {
    name: string;
    transport: string;
    security: number;
    constructor(options: {name: string; transport: string; security: number}) { Object.assign(this, options); }
    connect = jest.fn();
    sendData = jest.fn();
    scanWifiList = jest.fn();
    provision = jest.fn();
    disconnect = jest.fn();
  }
  return {ESPDevice, ESPProvisionManager: {searchESPDevices: jest.fn()}, ESPSecurity, ESPTransport};
});

const mockSearch = EspProvisioning.ESPProvisionManager.searchESPDevices as jest.Mock;

describe('ESP-IDF BLE and SoftAP provisioning', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the provisioning plugin for both BLE and H7608 SoftAP', async () => {
    jest.useFakeTimers();
    mockSearch
      .mockResolvedValueOnce([{name: 'PROV_001122334455', transport: 'ble', security: 1}])
      .mockResolvedValueOnce([{name: 'PROV_AABBCCDDEEFF', transport: 'softap', security: 3}]);
    const scan = new EdgezProvisioningManager().scan();
    await jest.advanceTimersByTimeAsync(6000);
    const {devices, warnings} = await scan;
    jest.useRealTimers();

    expect(warnings).toEqual([]);
    expect(mockSearch).toHaveBeenNthCalledWith(1, 'PROV_', 'ble', 1);
    expect(mockSearch).toHaveBeenNthCalledWith(2, 'PROV_', 'softap', 0);
    expect(devices.map(device => ({kind: device.kind, transport: device.transport}))).toEqual([
      {kind: 'esp32', transport: 'ble'},
      {kind: 'h7608', transport: 'softap'},
    ]);

    const h7608 = devices[1]!;
    const pluginDevice = (h7608 as unknown as {device: {
      connect: jest.Mock; sendData: jest.Mock; scanWifiList: jest.Mock; provision: jest.Mock;
    }}).device;
    pluginDevice.sendData.mockResolvedValue(JSON.stringify({ok: true, persisted: true}));
    pluginDevice.scanWifiList.mockResolvedValue([{ssid: 'Farm WiFi', rssi: -51, auth: 3}]);
    pluginDevice.provision.mockResolvedValue({status: 'success'});
    await h7608.connect('abcd1234');
    expect(pluginDevice.connect).toHaveBeenCalledWith(null, 'abcd1234', null);
    await expect(h7608.scanUpstreamWifi()).resolves.toEqual([{ssid: 'Farm WiFi', rssi: -51, auth: 3}]);
    await expect(h7608.provisionUpstreamWifi('Farm WiFi', 'secret12')).resolves.toBeUndefined();
    expect(pluginDevice.provision).toHaveBeenCalledWith('Farm WiFi', 'secret12');
    await expect(h7608.configure({
      clientId: 'client-1', username: h7608.serial, password: 'secret', projectId: 'project-1',
      channel: 'live', meshId: 'farm-mesh', passphrase: 'mesh-secret', country: 'US',
      halowChannel: 27, softapSsid: 'Barn Gateway',
    })).resolves.toEqual({ok: true, persisted: true});
    expect(pluginDevice.sendData).toHaveBeenCalledWith('mqtt-config', expect.stringContaining('"softapSsid":"Barn Gateway"'));
  });

  it('treats an empty native provisioning scan as a normal empty result', async () => {
    jest.useFakeTimers();
    mockSearch
      .mockRejectedValueOnce(new Error('java.lang.Error: No bluetooth device found with given prefix'))
      .mockRejectedValueOnce(new Error('java.lang.Error: No wifi device found with given prefix'));

    const scan = new EdgezProvisioningManager().scan();
    await jest.advanceTimersByTimeAsync(6000);
    await expect(scan).resolves.toEqual({devices: [], warnings: []});
    jest.useRealTimers();
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
    expect(received).toMatchObject({halowFrequencyKHz: 915500, deviceName: 'Long 🐄 tracker name', useDeviceGps: true});
    expect(received).not.toHaveProperty('softapSsid');
  });
});
