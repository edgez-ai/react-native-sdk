import {Root} from 'protobufjs/light';

const E = (values: Record<string, number>) => ({values});
const T = (type: string, id: number, extra: Record<string, unknown> = {}) => ({type, id, ...extra});

const root = Root.fromJSON({nested: {ai: {nested: {edgez: {nested: {halow: {nested: {
  Operation: E({OPERATION_UNSPECIFIED: 0, REQUEST: 1, RESPONSE: 2, ACKNOWLEDGE: 3, STREAMING: 4, BROADCAST: 9}),
  Interface: E({INTERFACE_UNSPECIFIED: 0, USB: 1, BLE: 2, WIFI: 3, ETHERNET: 4, HALOW: 5, LORA: 6, LIBP2P: 7}),
  Mime: E({MIME_UNSPECIFIED: 0, MIME_TEXT: 1, MIME_VOICE: 2, MIME_IMAGE: 3, MIME_VIDEO: 4, MIME_BINARY: 5, MIME_VOICE_CALL: 6}),
  MarkerColor: E({MARKER_DEFAULT: 0, MARKER_RED: 1, MARKER_BLUE: 2, MARKER_PURPLE: 3, MARKER_YELLOW: 4, MARKER_PINK: 5, MARKER_BROWN: 6, MARKER_GREEN: 7, MARKER_ORANGE: 8, MARKER_DEEP_PURPLE: 9, MARKER_LIGHT_BLUE: 10, MARKER_CYAN: 11, MARKER_TEAL: 12, MARKER_LIME: 13, MARKER_DEEP_ORANGE: 14, MARKER_GRAY: 15, MARKER_BLUE_GRAY: 16}),
  DeviceSettingsAction: E({DEVICE_SETTINGS_ACTION_UNSPECIFIED: 0, DEVICE_SETTINGS_GET: 1, DEVICE_SETTINGS_SET: 2, DEVICE_SETTINGS_REPORT: 3}),
  ScriptConfigAction: E({SCRIPT_CONFIG_ACTION_UNSPECIFIED: 0, SCRIPT_CONFIG_BEGIN: 1, SCRIPT_CONFIG_CHUNK: 2, SCRIPT_CONFIG_COMMIT: 3, SCRIPT_CONFIG_DELETE: 4, SCRIPT_CONFIG_REPORT: 5}),
  LicenseStatus: E({LICENSE_STATUS_UNSPECIFIED: 0, LICENSE_STATUS_AUTHORIZED: 1, LICENSE_STATUS_DEVICE_NOT_LICENSED: 2, LICENSE_STATUS_SDK_RELEASE_REQUIRED: 3, LICENSE_STATUS_SDK_VERSION_INCOMPATIBLE: 4, LICENSE_STATUS_SDK_RELEASE_INVALID: 5}),
  DeviceType: E({DEVICE_TYPE_UNSPECIFIED: 0, DEVICE_TYPE_UNKNOWN: 1, DEVICE_TYPE_USER: 2, DEVICE_TYPE_GATEWAY: 3, DEVICE_TYPE_BEACON: 4, DEVICE_TYPE_SENSOR: 5, DEVICE_TYPE_RELAY: 6}),
  AlertCondition: E({ALERT_CONDITION_UNSPECIFIED: 0, ALERT_CONDITION_ENTER: 1, ALERT_CONDITION_EXIT: 2, ALERT_CONDITION_NEAR: 3, ALERT_CONDITION_FAR: 4, ALERT_CONDITION_LOW_BATTERY: 5}),
  SensorType: E({SENSOR_UNKNOWN: 0, SENSOR_TEMPERATURE: 1, SENSOR_HUMIDITY: 2, SENSOR_LATITUDE: 3, SENSOR_LONGITUDE: 4, SENSOR_LENGTH: 5, SENSOR_ACCEL_X: 6, SENSOR_ACCEL_Y: 7, SENSOR_ACCEL_Z: 8, SENSOR_GYRO_X: 9, SENSOR_GYRO_Y: 10, SENSOR_GYRO_Z: 11}),
  MessageBody: {fields: {messageIdHigh: T('uint64', 1), messageIdLow: T('uint64', 2), sequence: T('sint32', 3), mime: T('Mime', 4), payload: T('bytes', 5), groupIdHigh: T('uint64', 6), groupIdLow: T('uint64', 7)}},
  SensorData: {oneofs: {value: {oneof: ['boolValue', 'intValue', 'floatValue']}}, fields: {type: T('SensorType', 1), boolValue: T('bool', 2), intValue: T('sint32', 3), floatValue: T('float', 4)}},
  Peer: {fields: {id: T('uint64', 1), rssi: T('sint32', 2), sensorData: T('SensorData', 3, {rule: 'repeated'}), routeTq: T('uint32', 4), routeHops: T('uint32', 5)}},
  Report: {fields: {peers: T('Peer', 1, {rule: 'repeated'})}},
  GeoFence: {fields: {idHigh: T('uint64', 1), idLow: T('uint64', 2), name: T('string', 3), marker: T('MarkerColor', 4), alertCondition: T('AlertCondition', 5), geoIndex: T('uint32', 6)}},
  Beacon: {fields: {userIdHigh: T('uint64', 1), userIdLow: T('uint64', 2), userName: T('string', 3), userPublicKey: T('bytes', 4), latitude: T('float', 5), longitude: T('float', 6), marker: T('MarkerColor', 7), deviceType: T('DeviceType', 8), channelNumber: T('uint32', 9), sleeping: T('bool', 10), geoFence: T('GeoFence', 100), sensorData: T('SensorData', 101, {rule: 'repeated'})}},
  HaLowInterfaceStatus: {fields: {supported: T('bool', 1), stackInitialized: T('bool', 2), meshMode: T('bool', 3), linkUp: T('bool', 4), routeReady: T('bool', 5), readyForReport: T('bool', 6), ethertype: T('uint32', 7), meshId: T('string', 8), ipAddr: T('string', 9), gateway: T('string', 10), macAddress: T('uint64', 11), licenseStatus: T('LicenseStatus', 12), firmwareVersion: T('string', 13), publicChannelMask: T('uint32', 14)}},
  HaLowInitConfig: {fields: {countryCode: T('string', 1), meshId: T('string', 2), passphrase: T('string', 3), maxHop: T('uint32', 4), userIdHigh: T('uint64', 5), userIdLow: T('uint64', 6), userName: T('string', 7), userPublicKey: T('bytes', 8), marker: T('string', 9), hasLocation: T('bool', 10), latitude: T('float', 11), longitude: T('float', 12), meshBandwidthMhz: T('uint32', 13), meshFrequencyKhz: T('uint32', 14), sdkCompatibility: T('string', 15), sdkReleaseId: T('string', 16), sdkReleaseSignature: T('bytes', 17), publicChannelMask: T('uint32', 18), hasPublicChannelMask: T('bool', 19)}},
  DeviceSettings: {fields: {action: T('DeviceSettingsAction', 1), deviceModeEnabled: T('bool', 2), meshId: T('string', 3), shareLocation: T('bool', 4), userName: T('string', 5), marker: T('MarkerColor', 6), beaconIntervalSeconds: T('uint32', 7), userIdHigh: T('uint64', 8), userIdLow: T('uint64', 9), userPublicKey: T('bytes', 10), userPrivateKey: T('bytes', 11), latitude: T('float', 12), longitude: T('float', 13), maxHop: T('uint32', 14), geoFence: T('GeoFence', 15), uartI2cSensorType: T('string', 16), rs485SensorType: T('string', 17), geoIndex: T('uint32', 18), passphrase: T('string', 19), upstreamWifiSsid: T('string', 20), upstreamWifiPassphrase: T('string', 21), beaconUnicast: T('uint64', 22), deviceType: T('DeviceType', 24), sleepModeEnabled: T('bool', 25), meshFrequencyKhz: T('uint32', 26), meshBandwidthMhz: T('uint32', 27), deviceGpsEnabled: T('bool', 28)}},
  LocationUpdate: {fields: {latitude: T('float', 1), longitude: T('float', 2), timestampMs: T('uint64', 3)}},
  ScriptConfig: {fields: {action: T('ScriptConfigAction', 1), scriptId: T('uint32', 2), name: T('string', 3), version: T('uint32', 4), totalSize: T('uint32', 5), offset: T('uint32', 6), chunk: T('bytes', 7), sensorType: T('string', 8), selectUartI2c: T('bool', 9), selectRs485: T('bool', 10), globalBufferSize: T('uint32', 11), mimeType: T('string', 12)}},
  NetworkPacket: {oneofs: {body: {oneof: ['payload', 'msg', 'status', 'init', 'deviceSettings', 'scriptConfig', 'beacon', 'report', 'locationUpdate']}}, fields: {from: T('uint64', 1), to: T('uint64', 2), operation: T('Operation', 3), interface: T('Interface', 4), payload: T('bytes', 100), msg: T('MessageBody', 101), status: T('HaLowInterfaceStatus', 102), init: T('HaLowInitConfig', 103), deviceSettings: T('DeviceSettings', 104), scriptConfig: T('ScriptConfig', 105), beacon: T('Beacon', 106), report: T('Report', 107), locationUpdate: T('LocationUpdate', 108)}},
}}}}}}}});

const packetType = root.lookupType('ai.edgez.halow.NetworkPacket');
const beaconType = root.lookupType('ai.edgez.halow.Beacon');

export type ProtocolObject = Record<string, any>;

function normalizeBigInts(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(normalizeBigInts);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeBigInts(item)]));
  }
  return value;
}

export function encodeNetworkPacket(packet: ProtocolObject): Uint8Array {
  const normalized = normalizeBigInts(packet) as ProtocolObject;
  const message = packetType.fromObject(normalized);
  const error = packetType.verify(message);
  if (error) throw new Error(`Invalid EdgeZ network packet: ${error}`);
  return packetType.encode(message).finish();
}

export function decodeNetworkPacket(bytes: Uint8Array): ProtocolObject {
  return packetType.toObject(packetType.decode(bytes), {longs: String, bytes: Uint8Array, defaults: false}) as ProtocolObject;
}

export function decodeBeacon(bytes: Uint8Array): ProtocolObject {
  return beaconType.toObject(beaconType.decode(bytes), {longs: String, bytes: Uint8Array, defaults: false}) as ProtocolObject;
}

export const Operation = {unspecified: 0, request: 1, response: 2, acknowledge: 3, streaming: 4, broadcast: 9} as const;
export const Interface = {unspecified: 0, usb: 1, ble: 2, wifi: 3, ethernet: 4, halow: 5, lora: 6, libp2p: 7} as const;
export const Mime = {unspecified: 0, text: 1, voice: 2, image: 3, video: 4, binary: 5, voiceCall: 6} as const;
