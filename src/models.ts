export type EdgezConnectionType = 'none' | 'ble';
export type EdgezMeshEventType =
  | 'connection' | 'bleDevice' | 'ready' | 'packet' | 'status' | 'node'
  | 'message' | 'voiceFrame' | 'voiceAudio' | 'otaProgress' | 'usb' | 'log';

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
  useDeviceGps?: boolean;
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
  enabledPublicChannels?: ReadonlySet<bigint>;
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
  publicChannelMask?: number;
  supportsPublicChannelMask?: boolean;
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
  channelNumber?: number;
  sleeping: boolean;
  enabled?: boolean;
}

export function edgezNodeId(nodeNum: bigint): string {
  return Array.from({length: 6}, (_, index) =>
    Number((nodeNum >> BigInt((5 - index) * 8)) & 0xffn).toString(16).padStart(2, '0'),
  ).join(':');
}

export function edgezNodeDisplayName(node: EdgezMeshNode): string {
  return node.displayName || edgezNodeId(node.nodeNum);
}

export const edgezPublicChannelPorts = [38801n, 38803n, 38805n, 38807n, 38809n] as const;
export const edgezPublicChannelAllMask = (1 << edgezPublicChannelPorts.length) - 1;

export function isEdgezPublicChannel(nodeNum: bigint): boolean {
  return edgezPublicChannelPorts.includes(nodeNum as typeof edgezPublicChannelPorts[number]);
}

export function edgezPublicChannelMask(ports: Iterable<bigint>): number {
  const enabled = new Set(ports);
  return edgezPublicChannelPorts.reduce(
    (mask, port, index) => enabled.has(port) ? mask | (1 << index) : mask,
    0,
  );
}

export function edgezPublicChannelsForMask(mask: number): ReadonlySet<bigint> {
  return new Set(edgezPublicChannelPorts.filter((_, index) => !!(mask & (1 << index))));
}

export function edgezPublicChannelNode(channel: number, enabled = true): EdgezMeshNode {
  if (channel < 1 || channel > edgezPublicChannelPorts.length) throw new RangeError('Unsupported public channel');
  const nodeNum = edgezPublicChannelPorts[channel - 1]!;
  return {
    nodeNum, userUuid: nodeNum.toString(), displayName: `channel${channel}`,
    route: 'PUBLIC', lastSeenMs: 0, marker: 'cyan', publicKey: new Uint8Array(),
    deviceType: 'PublicChannel', geoFenceName: '', geoIndex: 0,
    channelNumber: 0, sleeping: false, enabled,
  };
}

export function edgezNodeOpensConversation(node: EdgezMeshNode): boolean {
  if (isEdgezPublicChannel(node.nodeNum)) return true;
  const type = node.deviceType.trim().toLowerCase();
  return !type || type === 'unspecified' || type === 'user' || type === 'device_type_user';
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
  deviceGpsEnabled?: boolean;
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
  usbEvent?: string;
  usbTunnelState?: 'connecting' | 'connected' | 'message' | 'disconnected' | 'failed' | 'stopped';
  usbTunnelMessage?: string;
  usbFlash?: EdgezUsbFlashStatus;
  log?: string;
}

export interface EdgezUsbIpServerStatus {
  running: boolean;
  socketName?: string;
  routePort: number;
  devices: string[];
  tunnelState?: string;
  busId?: string;
}

export interface EdgezUsbDevice {
  busId: string;
  label: string;
  vendorId?: number;
  productId?: number;
}

export function edgezUsbDevices(status: EdgezUsbIpServerStatus): EdgezUsbDevice[] {
  return status.devices.flatMap(value => {
    const separator = value.indexOf('=');
    const busId = separator < 0 ? value : value.slice(0, separator);
    const label = separator < 0 ? value : value.slice(separator + 1);
    if (!/^\d+-\d+$/.test(busId)) return [];
    const ids = label.match(/\[([0-9a-f]{4}):([0-9a-f]{4})\]/i);
    return [{
      busId,
      label,
      vendorId: ids ? Number.parseInt(ids[1]!, 16) : undefined,
      productId: ids ? Number.parseInt(ids[2]!, 16) : undefined,
    }];
  });
}

export interface EdgezUsbFlashTunnelOptions {
  url: string;
  token: string;
  busId: string;
}

export interface EdgezManagedUsbFlashTunnelOptions {
  endpoint?: string;
  projectId: string;
  teamId: string;
  jwt: string;
  busId: string;
}

export interface EdgezUsbFlashSession {
  url: string;
  token: string;
  sessionId: string;
  expiresAt: number;
}

export interface EdgezUsbFlashJob {
  jobId: string;
  profile: string;
  baudRate?: EdgezEsp32FlashBaud;
  ackWindow?: EdgezEsp32FlashAckWindow;
  timeoutSeconds?: number;
  esptoolConfig?: EdgezEsptoolConfig;
  firmwareUri: string;
  size: number;
  sha256: string;
}

export interface EdgezUsbReleaseFlashJob {
  jobId: string;
  profile: string;
  baudRate?: EdgezEsp32FlashBaud;
  ackWindow?: EdgezEsp32FlashAckWindow;
  timeoutSeconds?: number;
  esptoolConfig?: EdgezEsptoolConfig;
  firmwareUrl: string;
  sha256: string;
}

export type EdgezEsp32Chip = 'esp32' | 'esp32s3' | 'esp32c3';
export type EdgezEsp32FlashBaud = 115200 | 230400 | 460800 | 921600;
export type EdgezEsp32FlashAckWindow = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type EdgezEsptoolConfig = 'standard' | 'high-latency';
export type EdgezUsbFlashState = 'downloading' | 'uploading' | 'verified' | 'flashing' | 'complete' | 'failed' | 'cancelled';

export interface EdgezUsbFirmwareInfo {
  firmwareUri: string;
  size: number;
  sha256: string;
}

export interface EdgezUsbFlashStatus {
  type: 'flash.status' | 'flash.log';
  jobId: string;
  state: EdgezUsbFlashState;
  message?: string;
  received?: number;
  size?: number;
  credit?: number;
}

export interface EdgezManagedEsp32FlashOptions extends EdgezManagedUsbFlashTunnelOptions {
  /** A full/merged flash image. The server writes this image at address 0x0. */
  firmwareUri: string;
  chip: EdgezEsp32Chip;
  /** Per-job esptool baud rate. The runtime defaults to 115200 when omitted. */
  baudRate?: EdgezEsp32FlashBaud;
  ackWindow?: EdgezEsp32FlashAckWindow;
  esptoolConfig?: EdgezEsptoolConfig;
  jobId?: string;
  connectTimeoutMs?: number;
  /** Abort only when no flash status or log arrives for this long. Defaults to 90 seconds. */
  flashInactivityTimeoutMs?: number;
  /** Absolute safety ceiling for the complete flash operation. Defaults to 30 minutes. */
  flashTimeoutMs?: number;
  keepTunnelOpen?: boolean;
  onProgress?: (status: EdgezUsbFlashStatus) => void;
}

export interface EdgezManagedEsp32ReleaseFlashOptions extends EdgezManagedUsbFlashTunnelOptions {
  /** A versioned GitHub release asset containing a full/merged flash image. */
  firmwareUrl: string;
  /** SHA-256 published in the GitHub release asset metadata. */
  sha256: string;
  chip: EdgezEsp32Chip;
  /** Per-job esptool baud rate. The runtime defaults to 115200 when omitted. */
  baudRate?: EdgezEsp32FlashBaud;
  ackWindow?: EdgezEsp32FlashAckWindow;
  esptoolConfig?: EdgezEsptoolConfig;
  jobId?: string;
  connectTimeoutMs?: number;
  /** Abort only when no flash status or log arrives for this long. Defaults to 90 seconds. */
  flashInactivityTimeoutMs?: number;
  /** Absolute safety ceiling for the complete flash operation. Defaults to 30 minutes. */
  flashTimeoutMs?: number;
  keepTunnelOpen?: boolean;
  onProgress?: (status: EdgezUsbFlashStatus) => void;
}

export interface EdgezManagedNrf54ReleaseFlashOptions extends EdgezManagedUsbFlashTunnelOptions {
  /** A versioned GitHub release asset containing an nRF54L15 Intel HEX image. */
  firmwareUrl: string;
  /** SHA-256 published in the GitHub release asset metadata. */
  sha256: string;
  jobId?: string;
  connectTimeoutMs?: number;
  /** Abort only when no flash status or log arrives for this long. Defaults to 90 seconds. */
  flashInactivityTimeoutMs?: number;
  /** Absolute safety ceiling for the complete flash operation. Defaults to 30 minutes. */
  flashTimeoutMs?: number;
  keepTunnelOpen?: boolean;
  onProgress?: (status: EdgezUsbFlashStatus) => void;
}

/** @deprecated Use EdgezManagedNrf54ReleaseFlashOptions for new integrations. */
export type EdgezManagedNrf54JLinkReleaseFlashOptions = EdgezManagedNrf54ReleaseFlashOptions;

export interface EdgezUsbFlashResult {
  jobId: string;
  chip: EdgezEsp32Chip;
  size: number;
  sha256: string;
  state: 'complete';
}

export type EdgezNrf54FlashProfile = 'nrf54l15-jlink' | 'nrf54l15-openocd';

export interface EdgezNrf54FlashResult<Profile extends EdgezNrf54FlashProfile = EdgezNrf54FlashProfile> {
  jobId: string;
  profile: Profile;
  size: number;
  sha256: string;
  state: 'complete';
}

export type EdgezNrf54JLinkFlashResult = EdgezNrf54FlashResult<'nrf54l15-jlink'>;
export type EdgezNrf54OpenOcdFlashResult = EdgezNrf54FlashResult<'nrf54l15-openocd'>;

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
    channelNumber: node.channelNumber || previous?.channelNumber || 0,
    enabled: previous?.enabled ?? node.enabled,
  };
}

export function bytesFromNative(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (typeof value === 'string') return Uint8Array.from(atob(value), c => c.charCodeAt(0));
  return new Uint8Array();
}
