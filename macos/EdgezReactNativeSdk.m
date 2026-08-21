#import "EdgezReactNativeSdk.h"

static NSString *const EdgezEventName = @"EdgezMeshEvent";
static NSString *const EdgezServiceUuid = @"FFF0";
static NSString *const EdgezRxUuid = @"FFF1";
static NSString *const EdgezTxUuid = @"FFF2";
static NSString *const EdgezForwardTxUuid = @"FFF4";
static NSString *const EdgezOtaUuid = @"FFF5";
static NSString *const EdgezOtaStatusUuid = @"FFF6";
static NSString *const EdgezVoiceTxUuid = @"FFF8";
static NSUInteger const EdgezMaximumPacketLength = 512;

@implementation EdgezReactNativeSdk {
  CBCentralManager *_central;
  NSMutableDictionary<NSString *, CBPeripheral *> *_devices;
  CBPeripheral *_peripheral;
  CBCharacteristic *_rx;
  CBCharacteristic *_ota;
  NSMutableData *_received;
  NSMutableData *_forwardReceived;
  NSMutableArray<NSData *> *_writeQueue;
  BOOL _writeInFlight;
  RCTPromiseResolveBlock _pendingScanResolve;
  RCTPromiseRejectBlock _pendingScanReject;
  NSUInteger _pendingNotificationSubscriptions;
}

RCT_EXPORT_MODULE(EdgezReactNativeSdk)

+ (BOOL)requiresMainQueueSetup { return YES; }

- (instancetype)init {
  if ((self = [super init])) {
    _devices = [NSMutableDictionary dictionary];
    _received = [NSMutableData data];
    _forwardReceived = [NSMutableData data];
    _writeQueue = [NSMutableArray array];
    _central = [[CBCentralManager alloc] initWithDelegate:self queue:dispatch_get_main_queue()];
  }
  return self;
}

- (NSArray<NSString *> *)supportedEvents { return @[EdgezEventName]; }

- (void)emit:(NSDictionary *)event {
  [self sendEventWithName:EdgezEventName body:event];
}

- (void)emitLog:(NSString *)message {
  [self emit:@{@"type": @"log", @"log": message}];
}

- (void)startScanning {
  [_devices removeAllObjects];
  [_central scanForPeripheralsWithServices:@[[CBUUID UUIDWithString:EdgezServiceUuid]]
                                    options:@{CBCentralManagerScanOptionAllowDuplicatesKey: @YES}];
  [self emitLog:@"BLE scan started"];
  if (_pendingScanResolve) _pendingScanResolve(nil);
  _pendingScanResolve = nil;
  _pendingScanReject = nil;
}

RCT_EXPORT_METHOD(startBleScan:(NSDictionary *)arguments
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self->_central.state == CBManagerStatePoweredOn) {
      [self startScanning];
    } else if (self->_central.state == CBManagerStateUnknown || self->_central.state == CBManagerStateResetting) {
      self->_pendingScanResolve = resolve;
      self->_pendingScanReject = reject;
    } else {
      reject(@"ble_unavailable", @"Bluetooth LE is unavailable or disabled", nil);
    }
  });
}

RCT_EXPORT_METHOD(stopBleScan:(NSDictionary *)arguments
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{ [self->_central stopScan]; resolve(nil); });
}

RCT_EXPORT_METHOD(connectBle:(NSDictionary *)arguments
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *deviceId = arguments[@"deviceId"];
  if (![deviceId isKindOfClass:NSString.class] || deviceId.length == 0) {
    reject(@"missing_device", @"Missing BLE device ID", nil);
    return;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    CBPeripheral *device = self->_devices[deviceId];
    if (!device) {
      NSUUID *identifier = [[NSUUID alloc] initWithUUIDString:deviceId];
      device = identifier ? [self->_central retrievePeripheralsWithIdentifiers:@[identifier]].firstObject : nil;
    }
    if (!device) {
      reject(@"device_missing", @"BLE device was not found; scan first", nil);
      return;
    }
    [self->_central stopScan];
    [self closePeripheral:NO];
    self->_peripheral = device;
    device.delegate = self;
    [self emitLog:[NSString stringWithFormat:@"Connecting BLE %@", deviceId]];
    [self->_central connectPeripheral:device options:nil];
    resolve(nil);
  });
}

RCT_EXPORT_METHOD(disconnect:(NSDictionary *)arguments
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [self->_central stopScan];
    [self closePeripheral:YES];
    resolve(nil);
  });
}

RCT_EXPORT_METHOD(initializeMesh:(NSDictionary *)arguments
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  [self queuePacket:arguments resolve:resolve reject:reject];
}

RCT_EXPORT_METHOD(sendPacket:(NSDictionary *)arguments
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  [self queuePacket:arguments resolve:resolve reject:reject];
}

RCT_EXPORT_METHOD(isOtaReady:(NSDictionary *)arguments resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { resolve(@(_peripheral != nil && _ota != nil)); }
RCT_EXPORT_METHOD(abortOta:(NSDictionary *)arguments resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { resolve(nil); }
RCT_EXPORT_METHOD(performOta:(NSDictionary *)arguments resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { reject(@"not_available", @"OTA is not available in the desktop transport yet", nil); }
RCT_EXPORT_METHOD(requestMicrophonePermission:(NSDictionary *)arguments resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { resolve(@NO); }
RCT_EXPORT_METHOD(requestNotificationPermission:(NSDictionary *)arguments resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { resolve(@NO); }
RCT_EXPORT_METHOD(notificationsAllowed:(NSDictionary *)arguments resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { resolve(@NO); }
RCT_EXPORT_METHOD(canUseFullScreenIntent:(NSDictionary *)arguments resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { resolve(@NO); }
RCT_EXPORT_METHOD(getBestKnownLocation:(NSDictionary *)arguments resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { resolve(nil); }
RCT_EXPORT_METHOD(clearCallLockScreenPresentation:(NSDictionary *)arguments resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { resolve(nil); }
RCT_EXPORT_METHOD(cancelIncomingCallNotification:(NSDictionary *)arguments resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { resolve(nil); }
RCT_EXPORT_METHOD(showIncomingMessageNotification:(NSDictionary *)arguments resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { resolve(@NO); }
RCT_EXPORT_METHOD(showIncomingCallNotification:(NSDictionary *)arguments resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { resolve(@NO); }
RCT_EXPORT_METHOD(startVoiceRecording:(NSDictionary *)arguments resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { reject(@"not_available", @"Voice recording is not available in the desktop transport yet", nil); }
RCT_EXPORT_METHOD(stopVoiceRecording:(NSDictionary *)arguments resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { resolve(nil); }
RCT_EXPORT_METHOD(playVoiceMessage:(NSDictionary *)arguments resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { reject(@"not_available", @"Voice playback is not available in the desktop transport yet", nil); }
RCT_EXPORT_METHOD(startLiveVoiceAudio:(NSDictionary *)arguments resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { reject(@"not_available", @"Live voice is not available in this release", nil); }
RCT_EXPORT_METHOD(stopLiveVoiceAudio:(NSDictionary *)arguments resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { resolve(nil); }
RCT_EXPORT_METHOD(playLiveVoiceAudio:(NSDictionary *)arguments resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { reject(@"not_available", @"Live voice is not available in this release", nil); }

- (void)queuePacket:(NSDictionary *)arguments resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  NSArray *values = arguments[@"packet"];
  if (![values isKindOfClass:NSArray.class] || values.count == 0) {
    reject(@"missing_packet", @"Missing EdgeZ packet", nil);
    return;
  }
  if (values.count > EdgezMaximumPacketLength) {
    reject(@"packet_too_large", @"EdgeZ packet exceeds 512 bytes", nil);
    return;
  }
  if (!_peripheral || !_rx) {
    reject(@"ble_not_ready", @"BLE control channel is not ready", nil);
    return;
  }
  NSMutableData *frame = [NSMutableData dataWithCapacity:values.count + 4];
  uint8_t header[4] = {'E', 'Z', values.count & 0xff, (values.count >> 8) & 0xff};
  [frame appendBytes:header length:sizeof(header)];
  for (NSNumber *value in values) {
    uint8_t byte = value.unsignedCharValue;
    [frame appendBytes:&byte length:1];
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    NSUInteger maximum = [self->_peripheral maximumWriteValueLengthForType:CBCharacteristicWriteWithResponse];
    if (maximum == 0) maximum = 20;
    for (NSUInteger offset = 0; offset < frame.length; offset += maximum) {
      NSUInteger length = MIN(maximum, frame.length - offset);
      [self->_writeQueue addObject:[frame subdataWithRange:NSMakeRange(offset, length)]];
    }
    [self writeNext];
    resolve(nil);
  });
}

- (void)writeNext {
  if (_writeInFlight || _writeQueue.count == 0 || !_peripheral || !_rx) return;
  _writeInFlight = YES;
  [_peripheral writeValue:_writeQueue.firstObject forCharacteristic:_rx type:CBCharacteristicWriteWithResponse];
}

- (void)closePeripheral:(BOOL)emitDisconnected {
  if (_peripheral && _peripheral.state != CBPeripheralStateDisconnected) [_central cancelPeripheralConnection:_peripheral];
  _peripheral.delegate = nil;
  _peripheral = nil;
  _rx = nil;
  _ota = nil;
  [_writeQueue removeAllObjects];
  _writeInFlight = NO;
  [_received setLength:0];
  [_forwardReceived setLength:0];
  if (emitDisconnected) [self emit:@{@"type": @"connection", @"connection": @"none"}];
}

- (void)centralManagerDidUpdateState:(CBCentralManager *)central {
  if (central.state == CBManagerStatePoweredOn && _pendingScanResolve) {
    [self startScanning];
  } else if (central.state != CBManagerStateUnknown && central.state != CBManagerStateResetting && _pendingScanReject) {
    _pendingScanReject(@"ble_unavailable", @"Bluetooth LE is unavailable or disabled", nil);
    _pendingScanResolve = nil;
    _pendingScanReject = nil;
  }
}

- (void)centralManager:(CBCentralManager *)central didDiscoverPeripheral:(CBPeripheral *)peripheral advertisementData:(NSDictionary<NSString *, id> *)advertisementData RSSI:(NSNumber *)RSSI {
  NSString *identifier = peripheral.identifier.UUIDString;
  _devices[identifier] = peripheral;
  NSString *name = advertisementData[CBAdvertisementDataLocalNameKey] ?: peripheral.name ?: @"";
  [self emit:@{@"type": @"bleDevice", @"bleDevice": @{@"id": identifier, @"name": name, @"rssi": RSSI ?: @0, @"lastSeenMs": @((long long)(NSDate.date.timeIntervalSince1970 * 1000))}}];
}

- (void)centralManager:(CBCentralManager *)central didConnectPeripheral:(CBPeripheral *)peripheral {
  [self emit:@{@"type": @"connection", @"connection": @"ble"}];
  [self emitLog:@"BLE connected; discovering EdgeZ service"];
  [peripheral discoverServices:@[[CBUUID UUIDWithString:EdgezServiceUuid]]];
}

- (void)centralManager:(CBCentralManager *)central didFailToConnectPeripheral:(CBPeripheral *)peripheral error:(NSError *)error {
  [self emitLog:[NSString stringWithFormat:@"BLE connection failed: %@", error.localizedDescription ?: @"unknown error"]];
  [self closePeripheral:YES];
}

- (void)centralManager:(CBCentralManager *)central didDisconnectPeripheral:(CBPeripheral *)peripheral error:(NSError *)error {
  [self closePeripheral:YES];
}

- (void)peripheral:(CBPeripheral *)peripheral didDiscoverServices:(NSError *)error {
  CBService *service = nil;
  for (CBService *candidate in peripheral.services) if ([candidate.UUID isEqual:[CBUUID UUIDWithString:EdgezServiceUuid]]) service = candidate;
  if (!service || error) {
    [self emitLog:@"EdgeZ BLE service is missing"];
    return;
  }
  [peripheral discoverCharacteristics:nil forService:service];
}

- (void)peripheral:(CBPeripheral *)peripheral didDiscoverCharacteristicsForService:(CBService *)service error:(NSError *)error {
  if (error) {
    [self emitLog:[NSString stringWithFormat:@"BLE characteristic discovery failed: %@", error.localizedDescription]];
    return;
  }
  NSArray<NSString *> *notificationUuids = @[EdgezTxUuid, EdgezForwardTxUuid, EdgezOtaStatusUuid, EdgezVoiceTxUuid];
  _pendingNotificationSubscriptions = 0;
  for (CBCharacteristic *characteristic in service.characteristics) {
    NSString *uuid = characteristic.UUID.UUIDString.uppercaseString;
    if ([uuid isEqualToString:EdgezRxUuid]) _rx = characteristic;
    if ([uuid isEqualToString:EdgezOtaUuid]) _ota = characteristic;
    if ([notificationUuids containsObject:uuid]) {
      _pendingNotificationSubscriptions++;
      [peripheral setNotifyValue:YES forCharacteristic:characteristic];
    }
  }
  if (!_rx) [self emitLog:@"EdgeZ BLE control characteristic FFF1 is missing"];
  if (_pendingNotificationSubscriptions == 0 && _rx) [self emit:@{@"type": @"ready"}];
}

- (void)peripheral:(CBPeripheral *)peripheral didUpdateNotificationStateForCharacteristic:(CBCharacteristic *)characteristic error:(NSError *)error {
  if (_pendingNotificationSubscriptions > 0) _pendingNotificationSubscriptions--;
  if (error) [self emitLog:[NSString stringWithFormat:@"BLE notification setup failed: %@", error.localizedDescription]];
  if (_pendingNotificationSubscriptions == 0 && _rx) [self emit:@{@"type": @"ready"}];
}

- (void)peripheral:(CBPeripheral *)peripheral didWriteValueForCharacteristic:(CBCharacteristic *)characteristic error:(NSError *)error {
  _writeInFlight = NO;
  if (!error && _writeQueue.count) [_writeQueue removeObjectAtIndex:0];
  if (error) {
    [_writeQueue removeAllObjects];
    [self emitLog:[NSString stringWithFormat:@"BLE write failed: %@", error.localizedDescription]];
  }
  [self writeNext];
}

- (void)peripheral:(CBPeripheral *)peripheral didUpdateValueForCharacteristic:(CBCharacteristic *)characteristic error:(NSError *)error {
  if (error || !characteristic.value.length) return;
  NSString *uuid = characteristic.UUID.UUIDString.uppercaseString;
  if ([uuid isEqualToString:EdgezTxUuid]) [self appendData:characteristic.value accumulator:_received route:nil];
  else if ([uuid isEqualToString:EdgezForwardTxUuid]) [self appendData:characteristic.value accumulator:_forwardReceived route:@"ble_forward"];
}

- (void)appendData:(NSData *)data accumulator:(NSMutableData *)accumulator route:(NSString *)route {
  [accumulator appendData:data];
  while (accumulator.length >= 4) {
    const uint8_t *bytes = accumulator.bytes;
    if (bytes[0] != 'E' || bytes[1] != 'Z') {
      [accumulator replaceBytesInRange:NSMakeRange(0, 1) withBytes:NULL length:0];
      continue;
    }
    NSUInteger length = bytes[2] | ((NSUInteger)bytes[3] << 8);
    if (length > EdgezMaximumPacketLength) {
      [accumulator setLength:0];
      [self emitLog:@"Discarded an oversized BLE frame"];
      return;
    }
    if (accumulator.length < length + 4) return;
    NSData *packet = [accumulator subdataWithRange:NSMakeRange(4, length)];
    const uint8_t *packetBytes = packet.bytes;
    NSMutableArray *values = [NSMutableArray arrayWithCapacity:length];
    for (NSUInteger index = 0; index < length; index++) [values addObject:@(packetBytes[index])];
    NSMutableDictionary *event = [@{@"type": @"packet", @"packet": values} mutableCopy];
    if (route) event[@"route"] = route;
    [self emit:event];
    [accumulator replaceBytesInRange:NSMakeRange(0, length + 4) withBytes:NULL length:0];
  }
}

@end
