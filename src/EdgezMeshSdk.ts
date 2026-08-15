import {NativeEventEmitter, NativeModules, Platform, type EmitterSubscription} from 'react-native';
import {gcm} from '@noble/ciphers/aes';
import {x25519} from '@noble/curves/ed25519';
import {sha256} from '@noble/hashes/sha256';
import {randomBytes} from '@noble/hashes/utils';
import {
  type EdgezConversationMessage,
  type EdgezDeviceSettings,
  type EdgezLocation,
  type EdgezMeshConfig,
  type EdgezMeshEvent,
  type EdgezMeshNode,
  type EdgezSdkReleaseCredential,
  type EdgezSensorScriptConfig,
  type EdgezVoiceChunk,
  type EdgezVoiceRecording,
  bytesFromNative,
  currentSdkRelease,
  edgezNodeDisplayName,
} from './models';
import {decodeBeacon, encodeNetworkPacket, Interface, Mime, Operation, type ProtocolObject} from './protocol';

export interface EdgezPlatformTransport {
  invoke<T = unknown>(method: string, arguments_?: Record<string, unknown>): Promise<T>;
  subscribe(listener: (event: EdgezMeshEvent) => void): () => void;
}

type NativeSdkModule = Record<string, (arguments_?: Record<string, unknown>) => Promise<unknown>> & {
  addListener(eventName: string): void;
  removeListeners(count: number): void;
};

export class EdgezNativeTransport implements EdgezPlatformTransport {
  private readonly native: NativeSdkModule;
  private readonly emitter: NativeEventEmitter;

  constructor() {
    const native = NativeModules.EdgezReactNativeSdk as NativeSdkModule | undefined;
    if (!native) {
      throw new Error(`@edgez/react-native-sdk is not linked${Platform.OS === 'ios' ? '; iOS is not supported yet' : ''}`);
    }
    this.native = native;
    this.emitter = new NativeEventEmitter(native);
  }

  async invoke<T>(method: string, arguments_: Record<string, unknown> = {}): Promise<T> {
    const fn = this.native[method];
    if (!fn) throw new Error(`Native EdgeZ method ${method} is unavailable`);
    return await fn.call(this.native, arguments_) as T;
  }

  subscribe(listener: (event: EdgezMeshEvent) => void): () => void {
    const subscription: EmitterSubscription = this.emitter.addListener('EdgezMeshEvent', raw => {
      const event = raw as EdgezMeshEvent;
      listener({...event, packet: event.packet === undefined ? undefined : bytesFromNative(event.packet)});
    });
    return () => subscription.remove();
  }
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const take = (value: string, max: number) => value.slice(0, max);
const u64 = (value: bigint) => BigInt.asUintN(64, value).toString();

function concat(...arrays: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(arrays.reduce((sum, item) => sum + item.length, 0));
  let offset = 0;
  for (const item of arrays) { result.set(item, offset); offset += item.length; }
  return result;
}

function littleInt64(value: bigint): Uint8Array {
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigInt64(0, value, true);
  return output;
}

function conversationAad(from: bigint, to: bigint, nonce: Uint8Array): Uint8Array {
  const header = new Uint8Array(18);
  const view = new DataView(header.buffer);
  view.setBigInt64(0, from, true);
  view.setBigInt64(8, to, true);
  view.setUint16(16, nonce.length, true);
  return concat(header, nonce);
}

function newUuidBytes(): Uint8Array {
  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return bytes;
}

function uuidFromBytes(bytes: Uint8Array): string {
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function idParts(): {high: bigint; low: bigint; uuid: string} {
  const bytes = newUuidBytes();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {high: view.getBigInt64(0), low: view.getBigInt64(8), uuid: uuidFromBytes(bytes)};
}

function encodeConversationPayload(nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (nonce.length > 127 || ciphertext.length > 0xffff) throw new Error('Conversation payload is too large');
  const length = ciphertext.length;
  const varint = length < 128 ? [length] : [(length & 0x7f) | 0x80, length >> 7];
  return Uint8Array.from([0x0a, nonce.length, ...nonce, 0x12, ...varint, ...ciphertext]);
}

function parseConversationPayload(payload: Uint8Array): {nonce: Uint8Array; ciphertext: Uint8Array} | undefined {
  let offset = 0;
  let nonce = new Uint8Array();
  let ciphertext = new Uint8Array();
  const readVarint = (): number | undefined => {
    let value = 0;
    for (let shift = 0; offset < payload.length && shift < 32; shift += 7) {
      const byte = payload[offset++]!;
      value |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) return value;
    }
    return undefined;
  };
  while (offset < payload.length) {
    const tag = readVarint();
    if (tag === undefined || (tag & 7) !== 2) return undefined;
    const length = readVarint();
    if (length === undefined || offset + length > payload.length) return undefined;
    const value = payload.slice(offset, offset + length);
    if (tag >> 3 === 1) nonce = value;
    if (tag >> 3 === 2) ciphertext = value;
    offset += length;
  }
  return nonce.length && ciphertext.length ? {nonce, ciphertext} : undefined;
}

export class EdgezMeshSdk {
  readonly transport: EdgezPlatformTransport;
  readonly releaseCredential: EdgezSdkReleaseCredential;
  private readonly keyCache = new Map<string, Uint8Array>();

  constructor(options: {transport?: EdgezPlatformTransport; releaseCredential?: EdgezSdkReleaseCredential} = {}) {
    this.transport = options.transport ?? new EdgezNativeTransport();
    this.releaseCredential = options.releaseCredential ?? currentSdkRelease;
  }

  subscribe(listener: (event: EdgezMeshEvent) => void): () => void { return this.transport.subscribe(listener); }
  startBleScan(): Promise<void> { return this.transport.invoke('startBleScan'); }
  stopBleScan(): Promise<void> { return this.transport.invoke('stopBleScan'); }
  connectBle(deviceId: string): Promise<void> { return this.transport.invoke('connectBle', {deviceId}); }
  disconnect(): Promise<void> { return this.transport.invoke('disconnect'); }
  requestMicrophonePermission(): Promise<boolean> { return this.transport.invoke('requestMicrophonePermission'); }
  requestNotificationPermission(): Promise<boolean> { return this.transport.invoke('requestNotificationPermission'); }
  notificationsAllowed(): Promise<boolean> { return this.transport.invoke('notificationsAllowed'); }
  canUseFullScreenIntent(): Promise<boolean> { return this.transport.invoke('canUseFullScreenIntent'); }
  isOtaReady(): Promise<boolean> { return this.transport.invoke('isOtaReady'); }
  abortOta(): Promise<void> { return this.transport.invoke('abortOta'); }
  getBestKnownLocation(): Promise<EdgezLocation | null> { return this.transport.invoke('getBestKnownLocation'); }
  clearCallLockScreenPresentation(): Promise<void> { return this.transport.invoke('clearCallLockScreenPresentation'); }
  cancelIncomingCallNotification(): Promise<void> { return this.transport.invoke('cancelIncomingCallNotification'); }
  startLiveVoiceAudio(): Promise<void> { return this.transport.invoke('startLiveVoiceAudio'); }
  stopLiveVoiceAudio(): Promise<void> { return this.transport.invoke('stopLiveVoiceAudio'); }
  playLiveVoiceAudio(audio: Uint8Array): Promise<void> { return this.transport.invoke('playLiveVoiceAudio', {audio: Array.from(audio)}); }

  async performOta(image: Uint8Array): Promise<string> {
    if (!image.length) throw new Error('OTA image is empty');
    return this.transport.invoke('performOta', {image: Array.from(image)});
  }

  async startVoiceRecording(): Promise<void> {
    if (!await this.requestMicrophonePermission()) throw new Error('Microphone permission denied');
    await this.transport.invoke('startVoiceRecording');
  }

  async stopVoiceRecording(send = true): Promise<EdgezVoiceRecording | null> {
    const result = await this.transport.invoke<Record<string, unknown> | null>('stopVoiceRecording', {send});
    return result ? {bytes: bytesFromNative(result.bytes), durationMs: Number(result.durationMs ?? 0), codec: Number(result.codec ?? 0)} : null;
  }

  playVoiceMessage(message: EdgezConversationMessage): Promise<void> {
    if (!message.voiceBytes.length) throw new Error('Voice message has no audio bytes');
    return this.transport.invoke('playVoiceMessage', {bytes: Array.from(message.voiceBytes), codec: message.voiceCodec});
  }

  showIncomingMessageNotification(message: EdgezConversationMessage, sender: EdgezMeshNode): Promise<boolean> {
    return this.transport.invoke('showIncomingMessageNotification', {sender: edgezNodeDisplayName(sender), body: message.voiceBytes.length ? 'Voice message' : message.text, nodeNum: u64(sender.nodeNum), messageId: message.messageUuid});
  }

  showIncomingCallNotification(callId: bigint, caller: EdgezMeshNode): Promise<boolean> {
    return this.transport.invoke('showIncomingCallNotification', {caller: edgezNodeDisplayName(caller), nodeNum: u64(caller.nodeNum), callId: u64(callId)});
  }

  async initializeMesh(config: EdgezMeshConfig): Promise<void> {
    const beacon = config.beacon ?? {};
    const packet = encodeNetworkPacket({operation: Operation.request, interface: Interface.halow, init: {
      countryCode: take((config.countryCode ?? 'US').toUpperCase(), 2), meshId: take(config.meshId ?? 'edgez', 32),
      passphrase: take(config.passphrase ?? '', 64), maxHop: clamp(config.maxHop ?? 4, 0, 255),
      userIdHigh: u64(config.identity.userIdHigh), userIdLow: u64(config.identity.userIdLow), userName: take(config.identity.name, 64),
      userPublicKey: config.identity.publicKey.slice(0, 32), marker: normalizeMarker(beacon.marker ?? 'blue'),
      hasLocation: !!beacon.shareLocation && beacon.latitude !== undefined && beacon.longitude !== undefined,
      latitude: beacon.shareLocation ? beacon.latitude : undefined, longitude: beacon.shareLocation ? beacon.longitude : undefined,
      meshBandwidthMhz: clamp(config.meshBandwidthMhz ?? 0, 0, 8), meshFrequencyKhz: Math.max(0, config.meshFrequencyKhz ?? 0),
      sdkCompatibility: this.releaseCredential.compatibility, sdkReleaseId: this.releaseCredential.releaseId,
      sdkReleaseSignature: this.releaseCredential.signature,
    }});
    await this.transport.invoke('initializeMesh', {packet: Array.from(packet)});
  }

  authorizeSession(): Promise<void> {
    return this.sendPacket('SDK license authorization', {operation: Operation.request, interface: Interface.halow, init: {
      sdkCompatibility: this.releaseCredential.compatibility, sdkReleaseId: this.releaseCredential.releaseId, sdkReleaseSignature: this.releaseCredential.signature,
    }});
  }

  requestDeviceSettings(): Promise<void> {
    return this.sendPacket('Device settings request', {operation: Operation.request, interface: Interface.halow, deviceSettings: {action: 1}});
  }

  sendDeviceSettings(settings: EdgezDeviceSettings, identity?: EdgezMeshConfig['identity']): Promise<void> {
    const packet: ProtocolObject = {operation: Operation.request, interface: Interface.halow, deviceSettings: {
      action: 2, deviceModeEnabled: settings.deviceModeEnabled ?? false, meshId: take(settings.meshId ?? '', 32), shareLocation: settings.shareLocation ?? false,
      userName: take(settings.userName ?? '', 64), marker: markerColor(settings.marker ?? 'green'), beaconIntervalSeconds: clamp(settings.beaconIntervalSeconds ?? 30, 5, 3600),
      maxHop: clamp(settings.maxHop ?? 0, 0, 255), latitude: settings.latitude, longitude: settings.longitude, geoIndex: settings.geoIndex ?? 0,
      uartI2cSensorType: take(settings.uartI2cSensorType ?? '', 32), rs485SensorType: take(settings.rs485SensorType ?? '', 32), passphrase: take(settings.passphrase ?? '', 64),
      upstreamWifiSsid: take(settings.upstreamWifiSsid ?? '', 32), upstreamWifiPassphrase: take(settings.upstreamWifiPassphrase ?? '', 64),
      beaconUnicast: u64(settings.beaconUnicast ?? 0n), deviceType: deviceType(settings.deviceType ?? 'relay'), sleepModeEnabled: settings.sleepModeEnabled ?? false,
      meshFrequencyKhz: Math.max(0, settings.meshFrequencyKhz ?? 0), meshBandwidthMhz: clamp(settings.meshBandwidthMhz ?? 0, 0, 8),
      ...(identity ? {userIdHigh: u64(identity.userIdHigh), userIdLow: u64(identity.userIdLow), userPublicKey: identity.publicKey, userPrivateKey: identity.privateKey} : {}),
    }};
    return this.sendPacket('Device settings update', packet, 3000);
  }

  async sendSensorScript(config: EdgezSensorScriptConfig): Promise<void> {
    if (config.action === 'delete') {
      return this.sendPacket('Driver delete', {operation: Operation.request, interface: Interface.halow, scriptConfig: {action: 4, scriptId: config.scriptId}});
    }
    const script = utf8.encode(config.script);
    const chunkSize = 220;
    await this.sendPacket('Driver upload begin', {operation: Operation.request, interface: Interface.halow, scriptConfig: scriptFields(config, {action: 1, totalSize: script.length})});
    for (let offset = 0; offset < script.length; offset += chunkSize) {
      await this.sendPacket('Driver upload chunk', {operation: Operation.request, interface: Interface.halow, scriptConfig: scriptFields(config, {action: 2, totalSize: script.length, offset, chunk: script.slice(offset, offset + chunkSize)})});
    }
    await this.sendPacket('Driver upload commit', {operation: Operation.request, interface: Interface.halow, scriptConfig: scriptFields(config, {action: 3, totalSize: script.length})}, 2000);
  }

  async sendTextMessage(config: EdgezMeshConfig, toNode: EdgezMeshNode, fromNode: bigint, text: string): Promise<string> {
    const id = idParts();
    const encrypted = this.encrypt(config, toNode, fromNode, utf8.encode(text));
    await this.sendPacket('Conversation message', {from: u64(fromNode), to: u64(toNode.nodeNum), operation: Operation.request, interface: Interface.halow,
      msg: {messageIdHigh: u64(id.high), messageIdLow: u64(id.low), sequence: 1, mime: Mime.text, payload: encodeConversationPayload(encrypted.nonce, encrypted.ciphertext)}});
    return id.uuid;
  }

  decryptTextMessage(config: EdgezMeshConfig, sender: EdgezMeshNode, fromNode: bigint, toNode: bigint, payload: Uint8Array): string {
    const parsed = parseConversationPayload(payload);
    if (!parsed) return utf8Decoder.decode(payload);
    return utf8Decoder.decode(this.decrypt(config, sender, fromNode, toNode, parsed.nonce, parsed.ciphertext));
  }

  async sendVoiceMessage(config: EdgezMeshConfig, toNode: EdgezMeshNode, fromNode: bigint, bytes: Uint8Array, durationMs: number, codec: number): Promise<string> {
    if (!bytes.length) throw new Error('Voice payload is empty');
    const id = idParts();
    const group = new DataView(randomBytes(8).buffer).getBigInt64(0);
    const total = Math.ceil(bytes.length / 290);
    for (let index = 0; index < total; index++) {
      const audio = bytes.slice(index * 290, Math.min((index + 1) * 290, bytes.length));
      const plaintext = encodeVoiceChunk(group, durationMs, total, index, codec, audio);
      const encrypted = this.encrypt(config, toNode, fromNode, plaintext);
      await this.sendPacket(`Voice chunk ${index + 1}/${total}`, {from: u64(fromNode), to: u64(toNode.nodeNum), operation: Operation.request, interface: Interface.halow,
        msg: {messageIdHigh: u64(id.high), messageIdLow: u64(id.low), sequence: index + 1, mime: Mime.voice, payload: encodeConversationPayload(encrypted.nonce, encrypted.ciphertext)}});
    }
    return id.uuid;
  }

  decryptVoiceChunk(config: EdgezMeshConfig, sender: EdgezMeshNode, fromNode: bigint, toNode: bigint, payload: Uint8Array): EdgezVoiceChunk {
    const parsed = parseConversationPayload(payload);
    if (!parsed) throw new Error('Conversation voice payload is missing');
    return decodeVoiceChunk(this.decrypt(config, sender, fromNode, toNode, parsed.nonce, parsed.ciphertext));
  }

  sendConversationAck(fromNode: bigint, toNode: bigint, messageIdHigh: bigint, messageIdLow: bigint): Promise<void> {
    return this.sendPacket('Conversation ACK', {from: u64(fromNode), to: u64(toNode), operation: Operation.acknowledge, interface: Interface.halow,
      msg: {messageIdHigh: u64(messageIdHigh), messageIdLow: u64(messageIdLow), mime: Mime.text}});
  }

  async decodeBeaconPayload(payload: Uint8Array, passphrase = ''): Promise<ProtocolObject | undefined> {
    let decoded = payload;
    try { decoded = Uint8Array.from(atob(utf8Decoder.decode(payload)), c => c.charCodeAt(0)); } catch {}
    if (passphrase && decoded.length > 32 && decoded.slice(0, 4).every((v, i) => v === [0x45, 0x5a, 0x42, 0x01][i])) {
      try { decoded = gcm(sha256(utf8.encode(passphrase)), decoded.slice(4, 16)).decrypt(decoded.slice(16)); } catch {}
    }
    try { return decodeBeacon(decoded); } catch { return undefined; }
  }

  private sendPacket(label: string, packet: ProtocolObject, waitForDrainMs = 0): Promise<void> {
    return this.transport.invoke('sendPacket', {label, packet: Array.from(encodeNetworkPacket(packet)), ...(waitForDrainMs ? {waitForDrainMs} : {})});
  }

  private conversationKey(config: EdgezMeshConfig, localNode: bigint, peer: EdgezMeshNode): Uint8Array {
    const local = config.identity;
    if (local.privateKey.length !== 32 || local.publicKey.length !== 32 || peer.publicKey.length !== 32) throw new Error('Conversation key pair is missing');
    const cacheKey = `${localNode}:${peer.nodeNum}:${Array.from(local.publicKey)}:${Array.from(peer.publicKey)}`;
    const cached = this.keyCache.get(cacheKey); if (cached) return cached;
    const shared = x25519.getSharedSecret(local.privateKey, peer.publicKey);
    const localBytes = concat(littleInt64(localNode), local.publicKey);
    const peerBytes = concat(littleInt64(peer.nodeNum), peer.publicKey);
    const firstLocal = localNode < peer.nodeNum || (localNode === peer.nodeNum && compareBytes(local.publicKey, peer.publicKey) <= 0);
    const key = sha256(concat(utf8.encode('EdgeZ conversation v1'), shared, firstLocal ? localBytes : peerBytes, firstLocal ? peerBytes : localBytes));
    this.keyCache.set(cacheKey, key);
    return key;
  }

  private encrypt(config: EdgezMeshConfig, recipient: EdgezMeshNode, fromNode: bigint, plaintext: Uint8Array) {
    const nonce = randomBytes(12);
    const cipher = gcm(this.conversationKey(config, fromNode, recipient), nonce, conversationAad(fromNode, recipient.nodeNum, nonce));
    return {nonce, ciphertext: cipher.encrypt(plaintext)};
  }

  private decrypt(config: EdgezMeshConfig, sender: EdgezMeshNode, fromNode: bigint, toNode: bigint, nonce: Uint8Array, ciphertext: Uint8Array) {
    return gcm(this.conversationKey(config, toNode, sender), nonce, conversationAad(fromNode, toNode, nonce)).decrypt(ciphertext);
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? -1) - (b[i] ?? -1); if (d) return d; } return 0; }
function normalizeMarker(marker: string): string { return ['default','red','blue','purple','yellow','pink','brown','green','orange','deep_purple','light_blue','cyan','teal','lime','deep_orange','gray','blue_gray'].includes(marker) ? marker : 'default'; }
function markerColor(marker: string): number { return ['default','red','blue','purple','yellow','pink','brown','green','orange','deep_purple','light_blue','cyan','teal','lime','deep_orange','gray','blue_gray'].indexOf(normalizeMarker(marker)); }
function deviceType(value: string): number { return ({unknown: 1, user: 2, gateway: 3, beacon: 4, sensor: 5, relay: 6} as Record<string, number>)[value.toLowerCase()] ?? 0; }
function scriptFields(config: EdgezSensorScriptConfig, fields: ProtocolObject): ProtocolObject { return {...fields, scriptId: config.scriptId, version: config.version, name: take(config.name, 64), sensorType: take(config.sensorType, 32), selectUartI2c: config.connector === 'uartI2c', selectRs485: config.connector === 'rs485', globalBufferSize: config.globalBufferSize ?? 4096, mimeType: take(config.mimeType ?? 'application/x-lua', 64)}; }
function encodeVoiceChunk(group: bigint, duration: number, total: number, index: number, codec: number, audio: Uint8Array): Uint8Array { const out = new Uint8Array(20 + audio.length); const view = new DataView(out.buffer); out.set([0x45,0x56,0x32]); view.setBigInt64(3, group, true); view.setInt32(11, clamp(duration,0,0x7fffffff), true); view.setUint16(15,total,true); view.setUint16(17,index,true); view.setUint8(19,codec); out.set(audio,20); return out; }
function decodeVoiceChunk(payload: Uint8Array): EdgezVoiceChunk { if (payload.length < 21 || payload[0] !== 0x45 || payload[1] !== 0x56 || payload[2] !== 0x32) throw new Error('Voice chunk is malformed'); const view = new DataView(payload.buffer,payload.byteOffset,payload.byteLength); const result = {groupId:view.getBigInt64(3,true),durationMs:view.getInt32(11,true),totalChunks:view.getUint16(15,true),index:view.getUint16(17,true),codec:view.getUint8(19),audio:payload.slice(20)}; if (!result.totalChunks || result.index >= result.totalChunks || !result.audio.length) throw new Error('Voice chunk is malformed'); return result; }
