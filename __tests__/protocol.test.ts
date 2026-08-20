import {decodeNetworkPacket, encodeNetworkPacket, Interface, Operation} from '../src/protocol';
import {EdgezOtaRelease} from '../src/ota';
import {
  edgezPublicChannelMask,
  edgezPublicChannelPorts,
  edgezPublicChannelsForMask,
  isEdgezPublicChannel,
} from '../src/models';

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

  it('round-trips node channels, public-channel status, and device GPS settings', () => {
    const packet = decodeNetworkPacket(encodeNetworkPacket({
      status: {publicChannelMask: 0b10101},
      operation: Operation.response,
      interface: Interface.halow,
    }));
    expect(packet.status.publicChannelMask).toBe(0b10101);

    const beacon = decodeNetworkPacket(encodeNetworkPacket({
      from: '42', beacon: {channelNumber: 11}, operation: Operation.broadcast, interface: Interface.halow,
    }));
    expect(beacon.beacon.channelNumber).toBe(11);

    const settings = decodeNetworkPacket(encodeNetworkPacket({
      deviceSettings: {deviceGpsEnabled: true, geoFence: {name: 'Warehouse', geoIndex: 3}},
      operation: Operation.response,
      interface: Interface.halow,
    }));
    expect(settings.deviceSettings).toMatchObject({deviceGpsEnabled: true, geoFence: {name: 'Warehouse', geoIndex: 3}});
  });

  it('maps Flutter-compatible public talkgroup ports to mask bits', () => {
    const selected = [edgezPublicChannelPorts[0], edgezPublicChannelPorts[2], edgezPublicChannelPorts[4]];
    expect(edgezPublicChannelMask(selected)).toBe(0b10101);
    expect([...edgezPublicChannelsForMask(0b10101)]).toEqual(selected);
    expect(isEdgezPublicChannel(38803n)).toBe(true);
    expect(isEdgezPublicChannel(38802n)).toBe(false);
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
