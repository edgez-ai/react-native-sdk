import {EdgezMeshSdk, type EdgezPlatformTransport} from '../src/EdgezMeshSdk';
import {decodeNetworkPacket} from '../src/protocol';
import type {EdgezMeshEvent, EdgezUserIdentity} from '../src/models';
import {EdgezMeshSession} from '../src/EdgezMeshSession';

class FakeTransport implements EdgezPlatformTransport {
  calls: Array<{method: string; arguments_?: Record<string, unknown>}> = [];
  async invoke<T>(method: string, arguments_?: Record<string, unknown>): Promise<T> { this.calls.push({method, arguments_}); return undefined as T; }
  subscribe(_listener: (event: EdgezMeshEvent) => void): () => void { return () => {}; }
}

const identity: EdgezUserIdentity = {userUuid: '00000000-0000-4000-8000-000000000016', userIdHigh: 11n, userIdLow: 22n, name: 'Protocol User', privateKey: new Uint8Array(32), publicKey: Uint8Array.from([1,2,3,4])};

describe('EdgezMeshSdk packet API', () => {
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
