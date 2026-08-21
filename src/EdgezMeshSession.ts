import type {
  EdgezBleDevice, EdgezConnectionType, EdgezConversationMessage, EdgezDeviceSettings,
  EdgezMeshConfig, EdgezMeshEvent, EdgezMeshNode, EdgezMeshStatus, EdgezSensorData,
  EdgezSensorSample, EdgezTopologyLink, EdgezVoiceCallState,
} from './models';
import {
  bytesFromNative, edgezPublicChannelAllMask, edgezPublicChannelMask,
  edgezPublicChannelNode, edgezPublicChannelPorts, emptyVoiceCall,
  isEdgezPublicChannel, mergeDiscovery,
} from './models';
import {EdgezMeshSdk} from './EdgezMeshSdk';
import {decodeNetworkPacket, Mime, Operation, type ProtocolObject} from './protocol';

export interface EdgezMeshState {
  connection: EdgezConnectionType;
  status?: EdgezMeshStatus;
  bleDevices: ReadonlyMap<string, EdgezBleDevice>;
  nodes: ReadonlyMap<bigint, EdgezMeshNode>;
  sensorSamples: ReadonlyMap<bigint, ReadonlyArray<EdgezSensorSample>>;
  topologyLinks: ReadonlyArray<EdgezTopologyLink>;
  conversations: ReadonlyMap<bigint, ReadonlyArray<EdgezConversationMessage>>;
  otaInProgress: boolean;
  otaReady: boolean;
  otaSentBytes: number;
  otaTotalBytes: number;
  voiceCall: EdgezVoiceCallState;
  statusLine: string;
  bleReady: boolean;
  bleConnecting: boolean;
  deviceSettings?: EdgezDeviceSettings;
}

export interface EdgezMeshSessionOptions {
  sdk?: EdgezMeshSdk;
  onIncomingMessage?: (message: EdgezConversationMessage, sender: EdgezMeshNode) => void;
  onIncomingCall?: (call: EdgezVoiceCallState, caller: EdgezMeshNode) => void;
}

const publicChannelNodes = (): Map<bigint, EdgezMeshNode> => new Map(
  edgezPublicChannelPorts.map((port, index) => [port, edgezPublicChannelNode(index + 1)]),
);

const initialState = (): EdgezMeshState => ({
  connection: 'none', bleDevices: new Map(), nodes: publicChannelNodes(), sensorSamples: new Map(), topologyLinks: [], conversations: new Map(),
  otaInProgress: false, otaReady: false, otaSentBytes: 0, otaTotalBytes: 0, voiceCall: emptyVoiceCall,
  statusLine: 'Connect with BLE, then save mesh settings.', bleReady: false, bleConnecting: false,
});

const bi = (value: unknown): bigint => { try { return BigInt(String(value ?? 0)); } catch { return 0n; } };
const num = (value: unknown): number => Number(value ?? 0);
const string = (value: unknown): string => typeof value === 'string' ? value : '';

export class EdgezMeshSession {
  readonly sdk: EdgezMeshSdk;
  private current: EdgezMeshState = initialState();
  private config?: EdgezMeshConfig;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeNative: () => void;
  private readonly onIncomingMessage?: EdgezMeshSessionOptions['onIncomingMessage'];
  private readonly onIncomingCall?: EdgezMeshSessionOptions['onIncomingCall'];
  private provisioning = false;
  private readonly pendingVoiceMessages = new Map<string, {durationMs: number; codec: number; chunks: Array<Uint8Array | undefined>}>();

  constructor(options: EdgezMeshSessionOptions = {}) {
    this.sdk = options.sdk ?? new EdgezMeshSdk();
    this.onIncomingMessage = options.onIncomingMessage;
    this.onIncomingCall = options.onIncomingCall;
    this.unsubscribeNative = this.sdk.subscribe(event => void this.handleEvent(event));
  }

  get state(): EdgezMeshState { return this.current; }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = (): EdgezMeshState => this.current;
  dispose(): void { this.unsubscribeNative(); this.listeners.clear(); }
  beginProvisioning(): void { this.provisioning = true; }
  endProvisioning(): void { this.provisioning = false; }

  restoreCachedMeshData(data: Partial<Pick<EdgezMeshState, 'nodes'|'sensorSamples'|'topologyLinks'|'conversations'>>): void {
    this.setState({...this.current, ...data, nodes: new Map([...publicChannelNodes().entries(), ...(data.nodes ?? this.current.nodes).entries()]), statusLine: 'Restored cached mesh data'});
  }

  async startBleScan(): Promise<void> {
    this.setState({...this.current, bleDevices: new Map(), statusLine: 'Scanning for EdgeZ BLE devices'});
    try { await this.sdk.startBleScan(); } catch (error) { this.setStatus(`BLE scan failed: ${error}`); throw error; }
  }
  async stopBleScan(): Promise<void> { await this.sdk.stopBleScan(); this.setStatus('BLE scan stopped'); }

  async connectBle(deviceId: string): Promise<void> {
    this.setState({...this.current, bleConnecting: true, status: undefined, deviceSettings: undefined, statusLine: `Starting BLE connection to ${deviceId}`});
    try { await this.sdk.connectBle(deviceId); this.setState({...this.current, bleReady: false, statusLine: 'BLE connection requested; waiting for the control service'}); }
    catch (error) { this.setState({...this.current, bleConnecting: false, statusLine: `BLE connect failed: ${error}`}); throw error; }
  }

  async disconnect(): Promise<void> { await this.sdk.disconnect(); this.setState({...initialState(), bleDevices: this.current.bleDevices, statusLine: 'BLE disconnected'}); }
  async initializeMesh(config: EdgezMeshConfig): Promise<void> {
    this.config = config;
    const enabled = config.enabledPublicChannels ?? new Set(edgezPublicChannelPorts);
    const nodes = new Map(this.current.nodes);
    for (const [index, port] of edgezPublicChannelPorts.entries()) {
      nodes.set(port, {...nodes.get(port) ?? edgezPublicChannelNode(index + 1), enabled: enabled.has(port)});
    }
    this.setState({...this.current, nodes});
    await this.sendInitIfReady(true);
  }
  async authorizeSession(): Promise<void> { await this.sdk.authorizeSession(); this.setStatus('SDK authorization requested'); }
  async requestDeviceSettings(): Promise<void> { await this.sdk.requestDeviceSettings(); this.setStatus('Device settings requested'); }
  async sendDeviceSettings(settings: EdgezDeviceSettings, identity?: EdgezMeshConfig['identity']): Promise<void> { await this.sdk.sendDeviceSettings(settings, identity); this.setStatus('Device settings sent'); }
  get enabledPublicChannels(): ReadonlySet<bigint> { return new Set(edgezPublicChannelPorts.filter(port => this.current.nodes.get(port)?.enabled !== false)); }
  async setPublicChannelEnabled(port: bigint, enabled: boolean): Promise<void> {
    if (!isEdgezPublicChannel(port)) throw new Error('Unsupported public channel');
    const nodes = new Map(this.current.nodes);
    const current = nodes.get(port) ?? edgezPublicChannelNode(edgezPublicChannelPorts.indexOf(port as typeof edgezPublicChannelPorts[number]) + 1);
    nodes.set(port, {...current, enabled});
    if (this.config) this.config = {...this.config, enabledPublicChannels: new Set(edgezPublicChannelPorts.filter(value => nodes.get(value)?.enabled !== false))};
    this.setState({...this.current, nodes, statusLine: `${current.displayName} ${enabled ? 'enabled' : 'disabled'}`});
    if (this.current.bleReady) await this.sdk.updatePublicChannels(this.enabledPublicChannels);
  }

  async performOta(image: Uint8Array): Promise<string> {
    this.setState({...this.current, otaInProgress: true, otaSentBytes: 0, otaTotalBytes: image.length, statusLine: 'Starting firmware update'});
    try { const result = await this.sdk.performOta(image); this.setState({...this.current, otaInProgress: false, otaSentBytes: image.length, statusLine: result}); return result; }
    catch (error) { this.setState({...this.current, otaInProgress: false, statusLine: `Firmware update failed: ${error}`}); throw error; }
  }
  async abortOta(): Promise<void> { await this.sdk.abortOta(); this.setState({...this.current, otaInProgress: false, statusLine: 'Firmware update cancelled'}); }

  async sendTextMessage(nodeNum: bigint, text: string): Promise<EdgezConversationMessage> {
    const config = this.requireConfig(), to = this.requireNode(nodeNum), from = this.requireLocalNode();
    const pendingId = `pending-${Date.now()}`;
    const pending: EdgezConversationMessage = {nodeNum, text, mine: true, timestampMs: Date.now(), messageUuid: pendingId, status: 'Sending', voiceBytes: new Uint8Array(), voiceCodec: 0, durationMs: 0};
    this.appendMessage(pending);
    try { const messageUuid = await this.sdk.sendTextMessage(config, to, from, text); const sent = {...pending, messageUuid, status: 'Sent'}; this.replaceMessage(pendingId, sent); return sent; }
    catch (error) { const failed = {...pending, status: `Failed: ${error}`}; this.replaceMessage(pendingId, failed); throw error; }
  }

  async startVoiceMessage(): Promise<boolean> { await this.sdk.startVoiceRecording(); this.setStatus('Recording voice message'); return true; }
  async cancelVoiceMessage(): Promise<void> { await this.sdk.stopVoiceRecording(false); this.setStatus('Voice recording cancelled'); }
  async finishVoiceMessage(nodeNum: bigint): Promise<EdgezConversationMessage | undefined> {
    const recording = await this.sdk.stopVoiceRecording(true); if (!recording) return undefined;
    const config = this.requireConfig(), to = this.requireNode(nodeNum), from = this.requireLocalNode();
    const messageUuid = await this.sdk.sendVoiceMessage(config, to, from, recording.bytes, recording.durationMs, recording.codec);
    const message: EdgezConversationMessage = {nodeNum, text: 'Voice message', mine: true, timestampMs: Date.now(), messageUuid, status: 'Sent', voiceBytes: recording.bytes, voiceCodec: recording.codec, durationMs: recording.durationMs};
    this.appendMessage(message); return message;
  }
  playVoiceMessage(message: EdgezConversationMessage): Promise<void> { return this.sdk.playVoiceMessage(message); }
  removeNode(nodeNum: bigint): void { if (isEdgezPublicChannel(nodeNum)) return; const nodes = new Map(this.current.nodes); nodes.delete(nodeNum); const sensorSamples = new Map(this.current.sensorSamples); sensorSamples.delete(nodeNum); this.setState({...this.current, nodes, sensorSamples, statusLine: 'Node removed'}); }

  private async sendInitIfReady(force = false): Promise<void> {
    if (!this.config) return;
    if (!this.current.bleReady && !force) { this.setStatus('Settings saved; waiting for BLE control service'); return; }
    if (!this.current.bleReady) { this.setStatus('Settings saved; connect BLE to initialize device'); return; }
    await this.sdk.initializeMesh(this.config); this.setStatus('Device initialization sent; requesting status');
    await this.sdk.requestDeviceSettings();
  }

  private async handleEvent(event: EdgezMeshEvent): Promise<void> {
    switch (event.type) {
      case 'connection': {
        const connection = event.connection ?? 'none';
        this.setState({...this.current, connection, bleConnecting: false, bleReady: connection === 'none' ? false : this.current.bleReady, status: connection === 'none' ? undefined : this.current.status, statusLine: connection === 'ble' ? 'BLE link connected; setting up control channel' : 'BLE disconnected'}); break;
      }
      case 'bleDevice': if (event.bleDevice) { const devices = new Map(this.current.bleDevices); devices.set(event.bleDevice.id, event.bleDevice); this.setState({...this.current, bleDevices: devices, statusLine: `Found ${event.bleDevice.name || event.bleDevice.id}`}); } break;
      case 'ready': this.setState({...this.current, bleReady: true, statusLine: 'BLE control channel ready; requesting device status'}); void this.sdk.isOtaReady().then(otaReady => this.setState({...this.current, otaReady})); if (!this.provisioning) void this.sendInitIfReady(); break;
      case 'packet': if (event.packet?.length) await this.handlePacket(event.packet); break;
      case 'otaProgress': { const sent = event.sentBytes ?? 0, total = event.totalBytes ?? 0; this.setState({...this.current, otaInProgress: true, otaSentBytes: sent, otaTotalBytes: total, statusLine: total ? `Installing firmware: ${Math.floor(sent / total * 100)}%` : 'Installing firmware'}); break; }
      case 'log': this.setStatus(event.log ?? ''); break;
      default: break;
    }
  }

  private async handlePacket(raw: Uint8Array): Promise<void> {
    let bytes = raw;
    if (raw.length >= 4 && raw[0] === 0x45 && raw[1] === 0x5a) { const length = raw[2]! | (raw[3]! << 8); if (length <= 512 && raw.length >= length + 4) bytes = raw.slice(4, length + 4); }
    let packet: ProtocolObject; try { packet = decodeNetworkPacket(bytes); } catch { return; }
    if (packet.status) this.handleStatus(packet.status as ProtocolObject);
    if (packet.deviceSettings) this.handleDeviceSettings(packet.deviceSettings as ProtocolObject);
    if (packet.report) this.handleReport(packet);
    if (packet.beacon) this.handleBeacon(packet, packet.beacon as ProtocolObject);
    else if (packet.payload) { const beacon = await this.sdk.decodeBeaconPayload(bytesFromNative(packet.payload), this.config?.passphrase); if (beacon) this.handleBeacon(packet, beacon); }
    if (packet.msg || packet.operation === Operation.acknowledge) await this.handleConversation(packet);
  }

  private handleStatus(status: ProtocolObject): void {
    const licenses = ['unspecified','authorized','deviceNotLicensed','sdkReleaseRequired','sdkVersionIncompatible','sdkReleaseInvalid'] as const;
    const supportsPublicChannelMask = status.publicChannelMask !== undefined;
    const publicChannelMask = supportsPublicChannelMask ? num(status.publicChannelMask) : edgezPublicChannelAllMask;
    this.setState({...this.current, status: {supported: !!status.supported, stackInitialized: !!status.stackInitialized, meshMode: !!status.meshMode, linkUp: !!status.linkUp, routeReady: !!status.routeReady, readyForReport: !!status.readyForReport, meshId: string(status.meshId), ipAddress: string(status.ipAddr), gateway: string(status.gateway), macAddress: bi(status.macAddress), licenseStatus: licenses[num(status.licenseStatus)] ?? 'unspecified', firmwareVersion: string(status.firmwareVersion), publicChannelMask, supportsPublicChannelMask}, statusLine: 'Device status received'});
    const desiredMask = edgezPublicChannelMask(this.enabledPublicChannels);
    if (supportsPublicChannelMask && publicChannelMask !== desiredMask && this.current.bleReady) {
      void this.sdk.updatePublicChannels(this.enabledPublicChannels).catch(error => this.setStatus(`Public channel update failed: ${error}`));
    }
  }

  private handleDeviceSettings(value: ProtocolObject): void {
    this.setState({...this.current, deviceSettings: {deviceModeEnabled: !!value.deviceModeEnabled, meshId: string(value.meshId), shareLocation: !!value.shareLocation, userName: string(value.userName), marker: marker(num(value.marker)), beaconIntervalSeconds: num(value.beaconIntervalSeconds), maxHop: num(value.maxHop), latitude: value.latitude === undefined ? undefined : num(value.latitude), longitude: value.longitude === undefined ? undefined : num(value.longitude), geoFenceName: string((value.geoFence as ProtocolObject | undefined)?.name), geoIndex: num((value.geoFence as ProtocolObject | undefined)?.geoIndex ?? value.geoIndex), uartI2cSensorType: string(value.uartI2cSensorType), rs485SensorType: string(value.rs485SensorType), passphrase: string(value.passphrase), upstreamWifiSsid: string(value.upstreamWifiSsid), upstreamWifiPassphrase: string(value.upstreamWifiPassphrase), beaconUnicast: bi(value.beaconUnicast), deviceType: deviceType(num(value.deviceType)).toLowerCase(), sleepModeEnabled: !!value.sleepModeEnabled, deviceGpsEnabled: !!value.deviceGpsEnabled, meshFrequencyKhz: num(value.meshFrequencyKhz), meshBandwidthMhz: num(value.meshBandwidthMhz), userIdHigh: bi(value.userIdHigh), userIdLow: bi(value.userIdLow), userPublicKey: bytesFromNative(value.userPublicKey), userPrivateKey: bytesFromNative(value.userPrivateKey)}, statusLine: 'Device settings received'});
  }

  private handleReport(packet: ProtocolObject): void {
    const reporter = bi(packet.from); if (!reporter) return;
    const now = Date.now(), links = new Map<string, EdgezTopologyLink>();
    for (const link of this.current.topologyLinks) if (link.lastSeenMs > now - 300_000) links.set(pairKey(link.reporterNodeNum, link.peerNodeNum), link);
    for (const peer of (packet.report as ProtocolObject).peers ?? []) { const peerNodeNum = bi(peer.id); if (!peerNodeNum || peerNodeNum === reporter) continue; const link = {reporterNodeNum: reporter, peerNodeNum, encodedRssi: num(peer.rssi) > 0 ? num(peer.rssi) : 1000, lastSeenMs: now}; links.set(pairKey(reporter, peerNodeNum), link); }
    this.setState({...this.current, topologyLinks: [...links.values()].sort((a,b) => b.lastSeenMs-a.lastSeenMs), statusLine: 'Topology report received'});
  }

  private handleBeacon(packet: ProtocolObject, beacon: ProtocolObject): void {
    const nodeNum = bi(packet.from); if (!nodeNum) return;
    if (this.current.status?.macAddress === nodeNum) return;
    const node: EdgezMeshNode = {nodeNum, userUuid: uuidFromParts(bi(beacon.userIdHigh), bi(beacon.userIdLow)), displayName: string(beacon.userName), route: this.current.connection.toUpperCase(), lastSeenMs: Date.now(), marker: marker(num(beacon.marker)), publicKey: bytesFromNative(beacon.userPublicKey), latitude: beacon.latitude ? num(beacon.latitude) : undefined, longitude: beacon.longitude ? num(beacon.longitude) : undefined, deviceType: deviceType(num(beacon.deviceType)), geoFenceName: string((beacon.geoFence as ProtocolObject | undefined)?.name), geoIndex: num((beacon.geoFence as ProtocolObject | undefined)?.geoIndex), channelNumber: num(beacon.channelNumber), sleeping: !!beacon.sleeping, enabled: true};
    const nodes = new Map(this.current.nodes); const merged = mergeDiscovery(node, nodes.get(nodeNum)); nodes.set(nodeNum, merged);
    const sensor = sensorData(beacon); const samples = new Map(this.current.sensorSamples); if (sensor) samples.set(nodeNum, [...samples.get(nodeNum) ?? [], {nodeNum, timestampMs: Date.now(), data: sensor}]);
    this.setState({...this.current, nodes, sensorSamples: samples, statusLine: `Beacon received from ${merged.displayName || nodeNum.toString(16)}`});
  }

  private async handleConversation(packet: ProtocolObject): Promise<void> {
    const msg = packet.msg as ProtocolObject | undefined; if (!msg) return;
    const uuid = uuidFromParts(bi(msg.messageIdHigh), bi(msg.messageIdLow));
    if (packet.operation === Operation.acknowledge) { this.markDelivered(uuid); return; }
    if (msg.mime !== Mime.text && msg.mime !== Mime.voice) return;
    const from = bi(packet.from), to = bi(packet.to), sender = this.current.nodes.get(from), config = this.config; if (!sender || !config) return;
    let message: EdgezConversationMessage;
    try {
      if (msg.mime === Mime.text) message = {nodeNum: from, text: this.sdk.decryptTextMessage(config, sender, from, to, bytesFromNative(msg.payload)), mine: false, timestampMs: Date.now(), messageUuid: uuid, status: '', voiceBytes: new Uint8Array(), voiceCodec: 0, durationMs: 0};
      else {
        const chunk = this.sdk.decryptVoiceChunk(config, sender, from, to, bytesFromNative(msg.payload));
        const complete = this.storeVoiceChunk(from, chunk);
        if (!complete) return;
        message = {nodeNum: from, text: 'Voice message', mine: false, timestampMs: Date.now(), messageUuid: uuid, status: '', voiceBytes: complete.bytes, voiceCodec: complete.codec, durationMs: complete.durationMs};
      }
    } catch (error) { message = {nodeNum: from, text: 'Unable to decrypt message', mine: false, timestampMs: Date.now(), messageUuid: uuid, status: String(error), voiceBytes: new Uint8Array(), voiceCodec: 0, durationMs: 0}; }
    this.appendMessage(message); this.onIncomingMessage?.(message, sender);
    const local = this.current.status?.macAddress; if (local) void this.sdk.sendConversationAck(local, from, bi(msg.messageIdHigh), bi(msg.messageIdLow));
  }

  private requireConfig(): EdgezMeshConfig { if (!this.config) throw new Error('Initialize the mesh before messaging'); return this.config; }
  private storeVoiceChunk(nodeNum: bigint, chunk: import('./models').EdgezVoiceChunk): {bytes: Uint8Array; codec: number; durationMs: number} | undefined {
    const key = `${nodeNum}:${chunk.groupId}`;
    const pending = this.pendingVoiceMessages.get(key) ?? {durationMs: chunk.durationMs, codec: chunk.codec, chunks: Array.from({length: chunk.totalChunks})};
    if (pending.chunks.length !== chunk.totalChunks || chunk.index >= pending.chunks.length) { this.pendingVoiceMessages.delete(key); return undefined; }
    pending.chunks[chunk.index] = chunk.audio;
    this.pendingVoiceMessages.set(key, pending);
    if (pending.chunks.some(value => value === undefined)) return undefined;
    this.pendingVoiceMessages.delete(key);
    const chunks = pending.chunks as Uint8Array[];
    const bytes = new Uint8Array(chunks.reduce((total, value) => total + value.length, 0));
    let offset = 0; for (const value of chunks) { bytes.set(value, offset); offset += value.length; }
    return {bytes, codec: pending.codec, durationMs: pending.durationMs};
  }
  private requireNode(node: bigint): EdgezMeshNode { const value = this.current.nodes.get(node); if (!value) throw new Error('Mesh node is unavailable'); return value; }
  private requireLocalNode(): bigint { const value = this.current.status?.macAddress; if (!value) throw new Error('Local mesh address is unavailable'); return value; }
  private appendMessage(message: EdgezConversationMessage): void { const conversations = new Map(this.current.conversations); conversations.set(message.nodeNum, [...conversations.get(message.nodeNum) ?? [], message]); this.setState({...this.current, conversations, statusLine: message.mine ? 'Message sent' : 'Conversation message received'}); }
  private replaceMessage(id: string, replacement: EdgezConversationMessage): void { const conversations = new Map(this.current.conversations); conversations.set(replacement.nodeNum, [...conversations.get(replacement.nodeNum) ?? []].map(m => m.messageUuid === id ? replacement : m)); this.setState({...this.current, conversations}); }
  private markDelivered(id: string): void { const conversations = new Map<bigint, ReadonlyArray<EdgezConversationMessage>>(); for (const [node, messages] of this.current.conversations) conversations.set(node, messages.map(m => m.mine && m.messageUuid === id ? {...m, status: 'Delivered'} : m)); this.setState({...this.current, conversations, statusLine: 'Message delivered'}); }
  private setStatus(statusLine: string): void { this.setState({...this.current, statusLine}); }
  private setState(state: EdgezMeshState): void { this.current = state; for (const listener of this.listeners) listener(); }
}

function pairKey(a: bigint, b: bigint): string { return a < b ? `${a}:${b}` : `${b}:${a}`; }
function marker(value: number): string { return ['default','red','blue','purple','yellow','pink','brown','green','orange','deep_purple','light_blue','cyan','teal','lime','deep_orange','gray','blue_gray'][value] ?? 'default'; }
function deviceType(value: number): string { return ['Unspecified','Unknown','User','Gateway','Beacon','Sensor','Relay'][value] ?? 'Unspecified'; }
function uuidFromParts(high: bigint, low: bigint): string { const text = `${BigInt.asUintN(64,high).toString(16).padStart(16,'0')}${BigInt.asUintN(64,low).toString(16).padStart(16,'0')}`; return `${text.slice(0,8)}-${text.slice(8,12)}-${text.slice(12,16)}-${text.slice(16,20)}-${text.slice(20)}`; }
function sensorData(beacon: ProtocolObject): EdgezSensorData | undefined { const out: EdgezSensorData = {}; for (const item of beacon.sensorData ?? []) { const value = item.floatValue ?? item.intValue; if (value === undefined) continue; const keys: Record<number,keyof EdgezSensorData> = {1:'temperature',2:'humidity',3:'latitude',4:'longitude',5:'binaryLengthBytes',6:'accelX',7:'accelY',8:'accelZ',9:'gyroX',10:'gyroY',11:'gyroZ'}; const key = keys[num(item.type)]; if (key) (out as Record<string,number>)[key] = num(value); } return Object.keys(out).length ? out : undefined; }
