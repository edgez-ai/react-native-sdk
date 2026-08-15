export type EdgezConnectionType = 'none' | 'ble';
export type EdgezMeshEventType =
  | 'connection' | 'bleDevice' | 'ready' | 'packet' | 'status' | 'node'
  | 'message' | 'voiceFrame' | 'voiceAudio' | 'otaProgress' | 'log';

export interface EdgezBleDevice {
  id: string;
  name: string;
  rssi: number;
  lastSeenMs: number;
}

export function edgezBleDeviceLabel(device: EdgezBleDevice): string {
  return device.name ? `${device.name} ${device.id}` : device.id;
}

export interface EdgezUserIdentity {
  userUuid: string;
  userIdHigh: bigint;
  userIdLow: bigint;
  name: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface EdgezBeaconConfig {
  intervalSeconds?: number;
  marker?: string;
  shareLocation?: boolean;
  latitude?: number;
  longitude?: number;
  locationTimestampMs?: number;
}

export interface EdgezMeshConfig {
  identity: EdgezUserIdentity;
  countryCode?: string;
  meshId?: string;
  passphrase?: string;
  maxHop?: number;
  meshBandwidthMhz?: number;
  meshFrequencyKhz?: number;
  beacon?: EdgezBeaconConfig;
}

export interface EdgezLocation {
  latitude: number;
  longitude: number;
  timestampMs: number;
}

export type EdgezLicenseStatus =
  | 'unspecified' | 'authorized' | 'deviceNotLicensed'
  | 'sdkReleaseRequired' | 'sdkVersionIncompatible' | 'sdkReleaseInvalid';

export interface EdgezMeshStatus {
  supported: boolean;
  stackInitialized: boolean;
  meshMode: boolean;
  linkUp: boolean;
  routeReady: boolean;
  readyForReport: boolean;
  meshId: string;
  ipAddress: string;
  gateway: string;
  macAddress: bigint;
  licenseStatus: EdgezLicenseStatus;
  firmwareVersion: string;
}

export function isMeshUsable(status?: EdgezMeshStatus): boolean {
  return !!status && status.supported && status.stackInitialized && status.linkUp && status.routeReady;
}

export interface EdgezMeshNode {
  nodeNum: bigint;
  userUuid: string;
  displayName: string;
  route: string;
  lastSeenMs: number;
  marker: string;
  publicKey: Uint8Array;
  latitude?: number;
  longitude?: number;
  deviceType: string;
  geoFenceName: string;
  geoIndex: number;
  sleeping: boolean;
}

export function edgezNodeId(nodeNum: bigint): string {
  return Array.from({length: 6}, (_, index) =>
    Number((nodeNum >> BigInt((5 - index) * 8)) & 0xffn).toString(16).padStart(2, '0'),
  ).join(':');
}

export function edgezNodeDisplayName(node: EdgezMeshNode): string {
  return node.displayName || edgezNodeId(node.nodeNum);
}

export interface EdgezSensorData {
  latitude?: number;
  longitude?: number;
  altitude?: number;
  temperature?: number;
  humidity?: number;
  pressure?: number;
  vibrationAverage?: number;
  accelX?: number;
  accelY?: number;
  accelZ?: number;
  gyroX?: number;
  gyroY?: number;
  gyroZ?: number;
  binaryLengthBytes?: number;
}

export interface EdgezSensorSample {
  nodeNum: bigint;
  timestampMs: number;
  data: EdgezSensorData;
}

export interface EdgezTopologyLink {
  reporterNodeNum: bigint;
  peerNodeNum: bigint;
  encodedRssi: number;
  lastSeenMs: number;
}

export interface EdgezConversationMessage {
  nodeNum: bigint;
  text: string;
  mine: boolean;
  timestampMs: number;
  messageUuid: string;
  status: string;
  voiceBytes: Uint8Array;
  voiceCodec: number;
  durationMs: number;
}

export type EdgezVoiceCallPhase = 'idle' | 'outgoing' | 'incoming' | 'active';
export interface EdgezVoiceCallState {
  peerNodeNum?: bigint;
  callId: bigint;
  phase: EdgezVoiceCallPhase;
}

export interface EdgezDeviceSettings {
  deviceModeEnabled?: boolean;
  meshId?: string;
  shareLocation?: boolean;
  userName?: string;
  marker?: string;
  beaconIntervalSeconds?: number;
  maxHop?: number;
  latitude?: number;
  longitude?: number;
  geoFenceName?: string;
  geoIndex?: number;
  uartI2cSensorType?: string;
  rs485SensorType?: string;
  passphrase?: string;
  upstreamWifiSsid?: string;
  upstreamWifiPassphrase?: string;
  beaconUnicast?: bigint;
  deviceType?: string;
  sleepModeEnabled?: boolean;
  meshFrequencyKhz?: number;
  meshBandwidthMhz?: number;
  userIdHigh?: bigint;
  userIdLow?: bigint;
  userPublicKey?: Uint8Array;
  userPrivateKey?: Uint8Array;
}

export type EdgezSensorConnector = 'uartI2c' | 'rs485';
export type EdgezSensorScriptAction = 'upload' | 'delete';
export interface EdgezSensorScriptConfig {
  scriptId: number;
  version: number;
  name: string;
  sensorType: string;
  connector: EdgezSensorConnector;
  script: string;
  globalBufferSize?: number;
  mimeType?: string;
  action?: EdgezSensorScriptAction;
}

export interface EdgezVoiceRecording { bytes: Uint8Array; durationMs: number; codec: number; }
export interface EdgezVoiceChunk { groupId: bigint; durationMs: number; totalChunks: number; index: number; codec: number; audio: Uint8Array; }

export interface EdgezMeshEvent {
  type: EdgezMeshEventType;
  connection?: EdgezConnectionType;
  bleDevice?: EdgezBleDevice;
  packet?: Uint8Array;
  sentBytes?: number;
  totalBytes?: number;
  log?: string;
}

export interface EdgezSdkReleaseCredential {
  compatibility: string;
  releaseId: string;
  signature: Uint8Array;
}

export const currentSdkRelease: EdgezSdkReleaseCredential = {
  compatibility: '^0.5.0',
  // Compatibility credential inherited from the 0.1.0 Flutter reference.
  // Replace with a React-Native-specific signed credential for publication.
  releaseId: 'edgez_flutter_sdk@0.1.0',
  signature: Uint8Array.from('0BEEE33C5291FEE11B66939E7641B490BA2CB307C394D905B15D7A08933D91DD141EC96081EDB5D1815A49B1C5D64EC774DEE9B4C67F2C935A84ABCB68ACA98B'.match(/../g)!.map(value => Number.parseInt(value, 16))),
};

export const emptyVoiceCall: EdgezVoiceCallState = {callId: 0n, phase: 'idle'};

export function mergeDiscovery(node: EdgezMeshNode, previous?: EdgezMeshNode): EdgezMeshNode {
  return {
    ...previous,
    ...node,
    userUuid: node.userUuid || previous?.userUuid || '',
    displayName: node.displayName || previous?.displayName || edgezNodeId(node.nodeNum),
    route: node.route || previous?.route || 'BLE',
    lastSeenMs: node.lastSeenMs || Date.now(),
    marker: node.marker || previous?.marker || 'blue',
    publicKey: node.publicKey.length ? node.publicKey : previous?.publicKey ?? new Uint8Array(),
    latitude: node.latitude ?? previous?.latitude,
    longitude: node.longitude ?? previous?.longitude,
    deviceType: node.deviceType || previous?.deviceType || 'Unspecified',
    geoFenceName: node.geoFenceName || previous?.geoFenceName || '',
    geoIndex: node.geoIndex || previous?.geoIndex || 0,
  };
}

export function bytesFromNative(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (typeof value === 'string') return Uint8Array.from(atob(value), c => c.charCodeAt(0));
  return new Uint8Array();
}
