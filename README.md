# EdgeZ React Native SDK

React Native/Expo SDK for EdgeZ HaLow mesh devices, ported from the EdgeZ
Flutter SDK. Native transports are included for Android, macOS, and Windows;
iOS is not yet implemented.

## Included

- BLE scan, connect, disconnect, EdgeZ framing, and event delivery
- HaLow mesh initialization and license credentials
- protobuf-compatible status, settings, beacon, topology, and message packets
- X25519 + AES-256-GCM encrypted conversations
- chunked encrypted voice-message protocol
- native Opus/AMR voice-message recording and playback
- device provisioning settings and Lua driver transfer
- BLE firmware OTA with acknowledged writes, progress, and cancellation
- Android BLE foreground service and message/call notification channels
- best-known Android location lookup for shared beacons
- identity, BLE preference, and installed-driver persistence
- stateful `EdgezMeshSession` and React `useEdgezMesh` hooks
- an Expo SDK 57 development-client example
- a shared-UI React Native desktop example for macOS and Windows

Live voice-call audio still needs to be ported from the Flutter native plugin.
Its public methods report `not_available` rather than silently behaving
incorrectly. Text and recorded voice messages are supported.

## Install

```sh
npm install @edgez/react-native-sdk \
  @react-native-async-storage/async-storage
```

The SDK contains native modules, so rebuild the native application after
installing it; Expo Go cannot load them.

On macOS the SDK autolinks through CocoaPods. On Windows it autolinks the C++
React Native Windows project and the consuming app must declare the Bluetooth
device capability.

## Basic use

```tsx
import React, {useEffect, useMemo} from 'react';
import {EdgezIdentityStore, EdgezMeshSession, useEdgezMesh} from '@edgez/react-native-sdk';

export function MeshScreen() {
  const session = useMemo(() => new EdgezMeshSession(), []);
  const state = useEdgezMesh(session);

  useEffect(() => () => session.dispose(), [session]);

  async function initialize() {
    const identity = await new EdgezIdentityStore().getOrCreate();
    await session.initializeMesh({
      identity,
      countryCode: 'SE',
      meshId: 'edgez',
      passphrase: '',
      maxHop: 4,
      beacon: {marker: 'blue'},
    });
  }

  // Render state.bleDevices, state.nodes, state.conversations, etc.
  return null;
}
```

Typical connection sequence:

```ts
await session.startBleScan();
await session.connectBle(device.id);
// When state.bleReady becomes true:
await session.initializeMesh(config);
await session.sendTextMessage(node.nodeNum, 'Hello mesh');
```

Applications that use another state architecture can construct `EdgezMeshSdk`
directly. Tests can inject an `EdgezPlatformTransport` without Android or BLE
hardware.

## Expo example

The [`example`](example/) follows the managed Expo structure used by
`template-iot-prov`: Expo SDK 57, `expo/AppEntry.js`, `app.config.js`, and a
development-client/EAS profile.

```sh
cd example
npm install
npm run android   # creates and installs the native Expo development build
npm run start     # later JavaScript-only iterations
```

The example includes BLE connection, mesh status, encrypted text and recorded
voice messages, notification permission, and OTA readiness. Its Flutter-aligned
Nodes tab groups discovered devices by HaLow channel, manages the five public
talkgroups, shows routes and node details, and exposes channel selection. The
Settings tab includes user identity/location, country/bandwidth/channel setup,
and device GPS, geofence, sensor, upstream network, and sleep controls.

## Desktop example

The [`desktop-example`](desktop-example/) reuses the same Nodes, Messages, and
Settings source as the Expo example. The macOS host uses React Native 0.81.6
with React Native macOS 0.81.9. Its [`windows-app`](desktop-example/windows-app/)
uses the actively supported React Native 0.84.1 and React Native Windows 0.84.0.
The hosts are separate because the current desktop platform versions do not
share a compatible React Native minor.

```sh
cd desktop-example
npm install

# macOS
npx pod-install macos
npm run macos

# Windows (run on Windows once before the first build)
cd windows-app
npm install
npm run windows:init
npm run windows
```

Desktop currently supports BLE scan/connect, framing, mesh setup, Nodes,
Settings, and encrypted text messages. OTA, OS notifications/location, and
recorded voice are still Android-only and fail explicitly on desktop.

## Development

```sh
npm install
npm run typecheck
npm test -- --runInBand
npm run build
```

The wire schema is committed at [`protos/edgez_mesh.proto`](protos/edgez_mesh.proto).
Protocol tests cover initialization fields, 64-bit IDs, topology reports, and
the Flutter-compatible 220-byte driver upload chunks.

## SDK release credential

The source currently carries the signed compatibility credential from the
Flutter `0.1.0` reference so it can target the same firmware compatibility
range. Before publishing an official React Native release, replace it with a
React-Native-specific credential signed by the EdgeZ SDK release process.
