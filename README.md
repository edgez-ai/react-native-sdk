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
- Android USB/IP host support for remote ESP32, J-Link, and OpenOCD flashing
- Android BLE foreground service and message/call notification channels
- best-known Android location lookup for shared beacons
- native Organic Maps view with mesh-node markers, offline map downloads,
  themes, 2D/3D perspective, and optional satellite tiles on Android
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

## Remote USB flashing (Android)

The Android SDK can export USB devices attached to the phone through the same
userspace USB/IP implementation used by EdgeZ Android DevTools. The phone owns
the USB connection; a separate flash server runs esptool, SEGGER J-Link tools,
or OpenOCD and reaches the SDK's abstract socket through the application's
authenticated tunnel.

For ESP32, the app can use the system document picker and the managed high-level
flow. `pickUsbFirmware` calculates the size and SHA-256 on Android without
loading the complete image into JavaScript. `discoverUsbDevices` starts USB
Host mode, asks for Android USB permission, and returns selectable bus IDs.

```ts
const sdk = new EdgezMeshSdk();
const firmware = await sdk.pickUsbFirmware();
if (!firmware) return; // The user closed the picker.

const [device] = await sdk.discoverUsbDevices();
if (!device) throw new Error('Connect an ESP32 over USB-C');

const result = await sdk.flashEsp32Firmware({
  endpoint: 'https://appwrite.edgez.ai/v1',
  projectId: appwriteProjectId,
  teamId: organizationId,
  jwt: await account.createJWT().then(value => value.jwt),
  busId: device.busId,
  chip: 'esp32s3', // also: esp32, esp32c3
  firmwareUri: firmware.firmwareUri,
  onProgress: status => {
    const percent = status.size ? Math.round(100 * (status.received ?? 0) / status.size) : undefined;
    console.log(status.state, percent, status.message);
  },
});
console.log(`Flashed ${result.size} bytes`);
```

The built-in ESP32 profiles write one full/merged image at address `0x0`.
Select a merged flash image produced for the exact chip and board. An ESP-IDF
OTA application image such as `*-ota.bin` is not a full device image and must
not be used with this flow.

`flashEsp32Firmware` waits for the WebSocket, uploads and verifies the image,
waits for esptool to finish, and closes the USB export afterward. Pass a stable
`jobId` if the UI needs a Cancel button, then call `cancelUsbFlash(jobId)`.

The lower-level API remains available when an application needs to keep a
tunnel open or manage several operations itself:

```ts
const sdk = new EdgezMeshSdk();
const status = await sdk.startManagedUsbFlashTunnel({
  endpoint: 'https://appwrite.edgez.ai/v1',
  projectId: appwriteProjectId,
  teamId: organizationId,
  jwt: await account.createJWT().then(result => result.jwt),
  busId: '1-2',
});

await sdk.flashUsbFirmware({
  jobId: 'flash-20260925-1',
  profile: 'esp32s3',
  firmwareUri: 'content://com.example.files/firmware.bin',
  size: 1048576,
  sha256: '<64 lowercase hex characters>',
});

// Optional cancellation; progress and tool logs arrive as usbTunnelMessage
// events containing flash.status / flash.log JSON.
await sdk.cancelUsbFlash('flash-20260925-1');

console.log(status.socketName, status.routePort, status.devices);

const unsubscribe = sdk.subscribe(event => {
  if (event.type === 'usb') console.log(event.usbEvent);
});

// Stop exporting USB when flashing is finished.
await sdk.stopUsbFlashTunnel();
unsubscribe();
```

`socketName` names an Android abstract Unix socket and is deliberately not a
public TCP listener. The app must pass it to its secure flash-server tunnel.
USB/IP route port `3240` is provided for tunnel routing. Android asks the user
for USB-host permission for each attached device. The transport supports
CP210x-style ESP32 serial flashing, SEGGER J-Link, and generic USB
control/bulk/interrupt transfers used by OpenOCD-compatible probes. The flash
server remains responsible for selecting firmware, invoking the flashing tool,
reporting progress, and authenticating the operation.

`startManagedUsbFlashTunnel` creates a five-minute, organization-scoped flash
session through the authenticated Appwrite API. The JWT is used only for that
HTTPS exchange and is not passed to the native tunnel. Applications that
already obtain a flash session can call `startUsbFlashTunnel` with its `url`
and `token` directly.

The tunnel requires `wss://`, sends its short-lived credential as a Bearer
token, identifies the selected USB device with `X-EdgeZ-USB-Bus-ID`, and sends
versioned binary frames that distinguish USB/IP from firmware chunks. The
runtime grants upload credits only after chunks are persisted. Text frames
control the flash job and are surfaced as USB tunnel events for status and
progress messages. Only one
tunnel can run in an SDK instance at a time, and a dropped connection is not
silently resumed during a flash.

## Organic Maps (Android)

The Android SDK includes EdgeZ Organic Maps `0.0.8`. Android API 26 or newer is required. The package supplies its
native dependencies and R8 rules; an Expo prebuild also needs the EdgeZ Ivy
repository and Java core-library desugaring. The example's
`withOrganicMaps` config plugin applies those settings automatically.

```tsx
import React, {useRef} from 'react';
import {
  EdgezOrganicMap,
  type EdgezOrganicMapRef,
} from '@edgez/react-native-sdk';

export function MapScreen() {
  const map = useRef<EdgezOrganicMapRef>(null);

  return <EdgezOrganicMap
    ref={map}
    style={{flex: 1}}
    nodes={[{
      id: 'node-1',
      label: 'Sheep tag',
      latitude: 59.3293,
      longitude: 18.0686,
      marker: 'blue',
      icon: 'sheep',
    }]}
    lines={[{
      id: 'pasture-boundary',
      points: [
        {latitude: 59.3293, longitude: 18.0686},
        {latitude: 59.3300, longitude: 18.0700},
        {latitude: 59.3285, longitude: 18.0710},
        {latitude: 59.3293, longitude: 18.0686},
      ],
      color: '#e88d29',
    }]}
    zoom={9}
    enableMapDownloads
    onMapRegionAvailable={regionId => map.current?.downloadRegion(regionId)}
    onMapError={console.warn}
  />;
}
```

The ref also supports camera reads/updates, day/night themes, 2D/3D
perspective, remote XYZ satellite tiles, and a bundled MBTiles satellite
asset. The component renders an availability message on non-Android platforms.
Lines are drawn by the native map renderer. Repeat the first point at the end
to close a geofence boundary.
Use `edgezMapIcons` for the supported icon names. `icon` and `marker` are
independent, so the same icon can use any supported marker color.

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
voice messages, notification permission, OTA readiness, and an Organic Maps tab
with geolocated mesh-node markers and offline downloads. Its Flutter-aligned
Nodes tab groups discovered devices by HaLow channel, manages the five public
talkgroups, shows routes and node details, and exposes channel selection. The
Settings tab includes user identity/location, country/bandwidth/channel setup,
and device GPS, geofence, sensor, upstream network, and sleep controls.

### Android example releases

The `Build Android example release` GitHub Actions workflow runs manually or
when a `v*` tag is pushed. Configure these repository secrets before running
it:

- `ANDROID_KEYSTORE_BASE64`: base64-encoded Android release keystore
- `ANDROID_KEYSTORE_PASSWORD`: keystore and key password

The keystore must contain the `edgez-android-release` alias. The workflow
builds the Expo native project once, preserves its unsigned APK, directly signs
that APK, signs the app bundle, verifies both signatures, and uploads all three
packages. Tag runs also attach the packages to the matching GitHub Release.

The `Build Windows example release` workflow uses the same manual and `v*` tag
triggers. It generates the ignored React Native Windows host, builds an x64
Release without deploying it, and uploads the complete Windows `AppPackages`
directory as `edgez-react-native-example-windows-x64.zip`. Keeping the package,
dependency files, and installation script together makes the artifact usable
as generated by the React Native Windows toolchain. Tag runs attach the ZIP to
the matching GitHub Release. This is the template's developer/test package;
production Windows code signing requires a trusted PFX certificate and matching
publisher identity, which are not currently configured in this repository.

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
