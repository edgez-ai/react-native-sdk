#import <CoreBluetooth/CoreBluetooth.h>
#import <React/RCTEventEmitter.h>

@interface EdgezReactNativeSdk : RCTEventEmitter <RCTBridgeModule, CBCentralManagerDelegate, CBPeripheralDelegate>
@end
