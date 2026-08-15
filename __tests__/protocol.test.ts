import {decodeNetworkPacket, encodeNetworkPacket, Interface, Operation} from '../src/protocol';
import {EdgezOtaRelease} from '../src/ota';

describe('EdgeZ protocol compatibility', () => {
  it('round-trips current initialization fields and uint64 values', () => {
    const bytes = encodeNetworkPacket({
      from: '20015998343868', operation: Operation.request, interface: Interface.halow,
      init: {countryCode: 'SE', meshId: 'edgez-test', maxHop: 7, meshFrequencyKhz: 915000, userIdHigh: '18446744073709551615'},
    });
    const packet = decodeNetworkPacket(bytes);
    expect(packet.from).toBe('20015998343868');
    expect(packet.init).toMatchObject({countryCode: 'SE', meshId: 'edgez-test', maxHop: 7, meshFrequencyKhz: 915000, userIdHigh: '18446744073709551615'});
  });

  it('preserves topology report peers', () => {
    const packet = decodeNetworkPacket(encodeNetworkPacket({from: '256', operation: Operation.broadcast, interface: Interface.halow, report: {peers: [{id: '512', rssi: 934}, {id: '768', rssi: 1000}]}}));
    expect(packet.report.peers).toHaveLength(2);
    expect(packet.report.peers[0]).toMatchObject({id: '512', rssi: 934});
  });
});

describe('EdgezOtaRelease', () => {
  it('validates manifests and compares semantic versions', () => {
    const release = EdgezOtaRelease.fromJson({version: 'v1.3.0', size: 4096, url: 'https://edgez.ai/fw.bin'});
    expect(release.isNewerThan('1.2.9')).toBe(true);
    expect(release.isNewerThan('1.3.0')).toBe(false);
    expect(() => EdgezOtaRelease.fromJson({version: '', size: 0, url: 'file:///tmp/fw'})).toThrow();
  });
});
