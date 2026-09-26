import {EdgezMeshSdk, type EdgezPlatformTransport} from '../src/EdgezMeshSdk';
import {decodeNetworkPacket} from '../src/protocol';
import {edgezUsbDevices, type EdgezMeshEvent, type EdgezUserIdentity} from '../src/models';
import {EdgezMeshSession} from '../src/EdgezMeshSession';

class FakeTransport implements EdgezPlatformTransport {
  calls: Array<{method: string; arguments_?: Record<string, unknown>}> = [];
  listener?: (event: EdgezMeshEvent) => void;
  async invoke<T>(method: string, arguments_?: Record<string, unknown>): Promise<T> { this.calls.push({method, arguments_}); return undefined as T; }
  subscribe(listener: (event: EdgezMeshEvent) => void): () => void { this.listener = listener; return () => { this.listener = undefined; }; }
  emit(event: EdgezMeshEvent): void { this.listener?.(event); }
}

const identity: EdgezUserIdentity = {userUuid: '00000000-0000-4000-8000-000000000016', userIdHigh: 11n, userIdLow: 22n, name: 'Protocol User', privateKey: new Uint8Array(32), publicKey: Uint8Array.from([1,2,3,4])};

describe('EdgezMeshSdk packet API', () => {
  it('exposes the Android USB/IP server lifecycle', async () => {
    const transport = new FakeTransport();
    const sdk = new EdgezMeshSdk({transport});
    await sdk.startUsbIpServer();
    await sdk.getUsbIpServerStatus();
    await sdk.stopUsbIpServer();
    expect(transport.calls.map(call => call.method)).toEqual(['startUsbIpServer', 'getUsbIpServerStatus', 'stopUsbIpServer']);
  });

  it('starts an authenticated USB flashing WebSocket tunnel', async () => {
    const transport = new FakeTransport();
    const sdk = new EdgezMeshSdk({transport});
    await sdk.startUsbFlashTunnel({url: 'wss://flash.edgez.ai/v1/tunnel', token: 'short-lived-token', busId: '1-2'});
    await sdk.stopUsbFlashTunnel();
    expect(transport.calls).toEqual([
      {method: 'startUsbFlashTunnel', arguments_: {url: 'wss://flash.edgez.ai/v1/tunnel', token: 'short-lived-token', busId: '1-2'}},
      {method: 'stopUsbFlashTunnel', arguments_: undefined},
    ]);
  });

  it('exchanges an Appwrite JWT for a managed USB flash tunnel', async () => {
    const transport = new FakeTransport();
    const sdk = new EdgezMeshSdk({transport});
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        url: 'wss://appwrite.edgez.ai/v1/usb-runtimes/team-1',
        token: 'short-lived-token',
        sessionId: 'session-1',
        expiresAt: 1800000300,
      }),
    }) as typeof fetch;
    try {
      await sdk.startManagedUsbFlashTunnel({
        projectId: 'project-1', teamId: 'team-1', jwt: 'jwt-1', busId: '1-2',
      });
      expect(global.fetch).toHaveBeenCalledWith(
        'https://appwrite.edgez.ai/v1/teams/team-1/usb-flash/sessions',
        expect.objectContaining({
          method: 'POST',
          credentials: 'omit',
          headers: expect.objectContaining({'X-Appwrite-Project': 'project-1', 'X-Appwrite-JWT': 'jwt-1'}),
        }),
      );
      expect(transport.calls.at(-1)).toEqual({
        method: 'startUsbFlashTunnel',
        arguments_: {
          url: 'wss://appwrite.edgez.ai/v1/usb-runtimes/team-1',
          token: 'short-lived-token',
          busId: '1-2',
        },
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('uploads and controls a USB flash job', async () => {
    const transport = new FakeTransport();
    const sdk = new EdgezMeshSdk({transport});
    const job = {
      jobId: 'flash-1', profile: 'esp32s3', firmwareUri: 'content://firmware/app.bin',
      baudRate: 460800 as const, size: 1024, sha256: 'a'.repeat(64),
    };
    await sdk.flashUsbFirmware(job);
    await sdk.cancelUsbFlash(job.jobId);
    expect(transport.calls.slice(-2)).toEqual([
      {method: 'flashUsbFirmware', arguments_: job},
      {method: 'cancelUsbFlash', arguments_: {jobId: 'flash-1'}},
    ]);
  });

  it('starts a URL-based USB flash job without uploading firmware', async () => {
    const transport = new FakeTransport();
    const sdk = new EdgezMeshSdk({transport});
    const job = {
      jobId: 'release-1', profile: 'esp32s3',
      baudRate: 460800 as const,
      firmwareUrl: 'https://github.com/edgez-ai/template/releases/download/v1.0.0/firmware.bin',
      sha256: 'c'.repeat(64),
    };
    await sdk.flashUsbReleaseFirmware(job);
    expect(transport.calls.at(-1)).toEqual({method: 'flashUsbReleaseFirmware', arguments_: job});
  });

  it('parses authorized Android USB devices for selection', () => {
    expect(edgezUsbDevices({running: true, routePort: 3240, devices: [
      '1-2=CP2102 USB to UART [10c4:ea60] busid=1-2',
    ]})).toEqual([{busId: '1-2', label: 'CP2102 USB to UART [10c4:ea60] busid=1-2', vendorId: 0x10c4, productId: 0xea60}]);
  });

  it('runs the managed ESP32 flash flow through completion', async () => {
    const transport = new FakeTransport();
    const sdk = new EdgezMeshSdk({transport});
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({url: 'wss://appwrite.edgez.ai/v1/usb-runtimes/team-1', token: 'token-1'}),
    }) as typeof fetch;
    const invoke = transport.invoke.bind(transport);
    transport.invoke = jest.fn(async <T,>(method: string, arguments_?: Record<string, unknown>) => {
      if (method === 'inspectUsbFirmware') return {firmwareUri: 'content://firmware/merged.bin', size: 4096, sha256: 'b'.repeat(64)} as T;
      const result = await invoke<T>(method, arguments_);
      if (method === 'startUsbFlashTunnel') queueMicrotask(() => transport.emit({type: 'usb', usbTunnelState: 'connected'}));
      if (method === 'flashUsbFirmware') queueMicrotask(() => {
        transport.emit({type: 'usb', usbFlash: {type: 'flash.status', jobId: 'esp32-test', state: 'uploading', received: 4096, size: 4096}});
        transport.emit({type: 'usb', usbFlash: {type: 'flash.status', jobId: 'esp32-test', state: 'complete'}});
      });
      return result;
    });
    const progress: string[] = [];
    try {
      await expect(sdk.flashEsp32Firmware({
        projectId: 'project-1', teamId: 'team-1', jwt: 'jwt-1', busId: '1-2',
        chip: 'esp32s3', baudRate: 460800, firmwareUri: 'content://firmware/merged.bin', jobId: 'esp32-test',
        onProgress: status => progress.push(status.state),
      })).resolves.toMatchObject({jobId: 'esp32-test', chip: 'esp32s3', state: 'complete', size: 4096});
      expect(progress).toEqual(['uploading', 'complete']);
      expect(transport.calls).toEqual(expect.arrayContaining([
        {method: 'flashUsbFirmware', arguments_: {jobId: 'esp32-test', profile: 'esp32s3', baudRate: 460800, ackWindow: 5, timeoutSeconds: 1800, esptoolConfig: 'high-latency', firmwareUri: 'content://firmware/merged.bin', size: 4096, sha256: 'b'.repeat(64)}},
        {method: 'stopUsbIpServer', arguments_: undefined},
      ]));
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('runs the managed ESP32 GitHub release flash flow through completion', async () => {
    const transport = new FakeTransport();
    const sdk = new EdgezMeshSdk({transport});
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({url: 'wss://appwrite.edgez.ai/v1/usb-runtimes/team-1', token: 'token-1'}),
    }) as typeof fetch;
    const invoke = transport.invoke.bind(transport);
    transport.invoke = jest.fn(async <T,>(method: string, arguments_?: Record<string, unknown>) => {
      const result = await invoke<T>(method, arguments_);
      if (method === 'startUsbFlashTunnel') queueMicrotask(() => transport.emit({type: 'usb', usbTunnelState: 'connected'}));
      if (method === 'flashUsbReleaseFirmware') queueMicrotask(() => {
        transport.emit({type: 'usb', usbFlash: {type: 'flash.status', jobId: 'release-test', state: 'downloading'}});
        transport.emit({type: 'usb', usbFlash: {type: 'flash.status', jobId: 'release-test', state: 'verified', size: 8192}});
        transport.emit({type: 'usb', usbFlash: {type: 'flash.status', jobId: 'release-test', state: 'complete'}});
      });
      return result;
    });
    const firmwareUrl = 'https://github.com/edgez-ai/template/releases/download/v1.0.0/firmware.bin';
    try {
      await expect(sdk.flashEsp32ReleaseFirmware({
        projectId: 'project-1', teamId: 'team-1', jwt: 'jwt-1', busId: '1-2', chip: 'esp32s3', baudRate: 460800,
        firmwareUrl, sha256: 'c'.repeat(64), jobId: 'release-test',
      })).resolves.toMatchObject({jobId: 'release-test', size: 8192, sha256: 'c'.repeat(64), state: 'complete'});
      expect(transport.calls).toEqual(expect.arrayContaining([
        {method: 'flashUsbReleaseFirmware', arguments_: {jobId: 'release-test', profile: 'esp32s3', baudRate: 460800, ackWindow: 5, timeoutSeconds: 1800, esptoolConfig: 'high-latency', firmwareUrl, sha256: 'c'.repeat(64)}},
      ]));
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('runs the managed nRF54L15 J-Link release flash flow through completion', async () => {
    const transport = new FakeTransport();
    const sdk = new EdgezMeshSdk({transport});
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({url: 'wss://appwrite.edgez.ai/v1/usb-runtimes/team-1', token: 'token-1'}),
    }) as typeof fetch;
    const invoke = transport.invoke.bind(transport);
    transport.invoke = jest.fn(async <T,>(method: string, arguments_?: Record<string, unknown>) => {
      const result = await invoke<T>(method, arguments_);
      if (method === 'startUsbFlashTunnel') queueMicrotask(() => transport.emit({type: 'usb', usbTunnelState: 'connected'}));
      if (method === 'flashUsbReleaseFirmware') queueMicrotask(() => {
        transport.emit({type: 'usb', usbFlash: {type: 'flash.status', jobId: 'nrf54-test', state: 'verified', size: 16384}});
        transport.emit({type: 'usb', usbFlash: {type: 'flash.status', jobId: 'nrf54-test', state: 'complete'}});
      });
      return result;
    });
    const firmwareUrl = 'https://github.com/edgez-ai/template/releases/download/v1.0.0/live-stocking-hc01.hex';
    try {
      await expect(sdk.flashNrf54JLinkReleaseFirmware({
        projectId: 'project-1', teamId: 'team-1', jwt: 'jwt-1', busId: '2-1',
        firmwareUrl, sha256: 'd'.repeat(64), jobId: 'nrf54-test',
      })).resolves.toMatchObject({jobId: 'nrf54-test', profile: 'nrf54l15-jlink', size: 16384, state: 'complete'});
      expect(transport.calls).toEqual(expect.arrayContaining([
        {method: 'flashUsbReleaseFirmware', arguments_: {jobId: 'nrf54-test', profile: 'nrf54l15-jlink', timeoutSeconds: 1800, firmwareUrl, sha256: 'd'.repeat(64)}},
      ]));
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('runs the managed nRF54L15 OpenOCD release flash flow through completion', async () => {
    const transport = new FakeTransport();
    const sdk = new EdgezMeshSdk({transport});
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({url: 'wss://appwrite.edgez.ai/v1/usb-runtimes/team-1', token: 'token-1'}),
    }) as typeof fetch;
    const invoke = transport.invoke.bind(transport);
    transport.invoke = jest.fn(async <T,>(method: string, arguments_?: Record<string, unknown>) => {
      const result = await invoke<T>(method, arguments_);
      if (method === 'startUsbFlashTunnel') queueMicrotask(() => transport.emit({type: 'usb', usbTunnelState: 'connected'}));
      if (method === 'flashUsbReleaseFirmware') queueMicrotask(() => {
        transport.emit({type: 'usb', usbFlash: {type: 'flash.status', jobId: 'nrf54-openocd-test', state: 'verified', size: 32768}});
        transport.emit({type: 'usb', usbFlash: {type: 'flash.status', jobId: 'nrf54-openocd-test', state: 'complete'}});
      });
      return result;
    });
    const firmwareUrl = 'https://github.com/edgez-ai/template/releases/download/v1.0.0/live-stocking-nrf54l15-sense.hex';
    try {
      await expect(sdk.flashNrf54OpenOcdReleaseFirmware({
        projectId: 'project-1', teamId: 'team-1', jwt: 'jwt-1', busId: '2-1',
        firmwareUrl, sha256: 'e'.repeat(64), jobId: 'nrf54-openocd-test',
      })).resolves.toMatchObject({jobId: 'nrf54-openocd-test', profile: 'nrf54l15-openocd', size: 32768, state: 'complete'});
      expect(transport.calls).toEqual(expect.arrayContaining([
        {method: 'flashUsbReleaseFirmware', arguments_: {jobId: 'nrf54-openocd-test', profile: 'nrf54l15-openocd', timeoutSeconds: 1800, firmwareUrl, sha256: 'e'.repeat(64)}},
      ]));
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('initializes with Flutter-compatible fields', async () => {
    const transport = new FakeTransport();
    const sdk = new EdgezMeshSdk({transport, releaseCredential: {compatibility: '^0.5.0', releaseId: 'edgez-react-native-sdk@test', signature: new Uint8Array(64)}});
    await sdk.initializeMesh({identity, countryCode: 'se', meshId: 'edgez-test', passphrase: 'secret', maxHop: 7, meshBandwidthMhz: 4, meshFrequencyKhz: 915000, beacon: {marker: 'teal', shareLocation: true, latitude: 59.33, longitude: 18.06}});
    const call = transport.calls[0]!;
    const packet = decodeNetworkPacket(Uint8Array.from(call.arguments_!.packet as number[]));
    expect(call.method).toBe('initializeMesh');
    expect(packet.init).toMatchObject({countryCode: 'SE', marker: 'teal', hasLocation: true, meshBandwidthMhz: 4, meshFrequencyKhz: 915000, sdkCompatibility: '^0.5.0', publicChannelMask: 31, hasPublicChannelMask: true});
  });

  it('uploads drivers as begin, 220-byte chunks, commit', async () => {
    const transport = new FakeTransport(); const sdk = new EdgezMeshSdk({transport});
    await sdk.sendSensorScript({scriptId: 1003, version: 2, name: 'Random Temperature', sensorType: '1003-1', connector: 'uartI2c', script: 'x'.repeat(500)});
    const packets = transport.calls.map(call => decodeNetworkPacket(Uint8Array.from(call.arguments_!.packet as number[])));
    expect(packets.map(packet => packet.scriptConfig.action)).toEqual([1,2,2,2,3]);
    expect(packets.slice(1,4).map(packet => packet.scriptConfig.chunk.length)).toEqual([220,220,60]);
    expect(transport.calls[4]!.arguments_!.waitForDrainMs).toBe(2000);
  });
});

describe('EdgezMeshSession voice assembly', () => {
  it('waits for every chunk and restores original ordering', () => {
    const session = new EdgezMeshSession({sdk: new EdgezMeshSdk({transport: new FakeTransport()})});
    const store = (session as unknown as {storeVoiceChunk(node: bigint, chunk: {groupId: bigint; durationMs: number; totalChunks: number; index: number; codec: number; audio: Uint8Array}): {bytes: Uint8Array} | undefined}).storeVoiceChunk.bind(session);
    const base = {groupId: 7n, durationMs: 900, totalChunks: 3, codec: 2};
    expect(store(42n, {...base, index: 2, audio: Uint8Array.of(5, 6)})).toBeUndefined();
    expect(store(42n, {...base, index: 0, audio: Uint8Array.of(1, 2)})).toBeUndefined();
    expect(Array.from(store(42n, {...base, index: 1, audio: Uint8Array.of(3, 4)})!.bytes)).toEqual([1, 2, 3, 4, 5, 6]);
    session.dispose();
  });
});

describe('EdgezMeshSession BLE recovery', () => {
  it('resends HaLow INIT whenever a recovered control channel becomes ready', async () => {
    const transport = new FakeTransport();
    const session = new EdgezMeshSession({sdk: new EdgezMeshSdk({transport})});
    await session.initializeMesh({identity, countryCode: 'US', meshId: 'edgez', passphrase: 'edgez123'});

    transport.emit({type: 'connection', connection: 'ble'});
    transport.emit({type: 'ready'});
    await Promise.resolve(); await Promise.resolve();
    expect(transport.calls.filter(call => call.method === 'initializeMesh')).toHaveLength(1);

    transport.emit({type: 'connection', connection: 'ble'});
    transport.emit({type: 'ready'});
    await Promise.resolve(); await Promise.resolve();
    expect(transport.calls.filter(call => call.method === 'initializeMesh')).toHaveLength(2);
    session.dispose();
  });
});

describe('EdgezMeshSession beacon locations', () => {
  it('uses received device GPS sensor coordinates for the node UI', () => {
    const session = new EdgezMeshSession({sdk: new EdgezMeshSdk({transport: new FakeTransport()})});
    const handleBeacon = (session as unknown as {handleBeacon(packet: Record<string, unknown>, beacon: Record<string, unknown>): void}).handleBeacon.bind(session);
    handleBeacon({from: '42'}, {
      userName: 'GPS node', latitude: 1, longitude: 2,
      sensorData: [{type: 3, floatValue: 59.3293}, {type: 4, floatValue: 18.0686}],
    });
    const node = session.state.nodes.get(42n)!;
    expect(node.latitude).toBeCloseTo(59.3293, 4);
    expect(node.longitude).toBeCloseTo(18.0686, 4);
    expect(session.state.sensorSamples.get(42n)?.at(-1)?.data).toMatchObject({latitude: 59.3293, longitude: 18.0686});
    session.dispose();
  });

  it('accepts valid equator or prime-meridian coordinates but rejects 0,0', () => {
    const session = new EdgezMeshSession({sdk: new EdgezMeshSdk({transport: new FakeTransport()})});
    const handleBeacon = (session as unknown as {handleBeacon(packet: Record<string, unknown>, beacon: Record<string, unknown>): void}).handleBeacon.bind(session);
    handleBeacon({from: '43'}, {userName: 'Equator node', latitude: 0, longitude: 18.0686});
    handleBeacon({from: '44'}, {userName: 'Invalid node', latitude: 0, longitude: 0});
    expect(session.state.nodes.get(43n)).toMatchObject({latitude: 0});
    expect(session.state.nodes.get(44n)?.latitude).toBeUndefined();
    expect(session.state.nodes.get(44n)?.longitude).toBeUndefined();
    session.dispose();
  });
});
