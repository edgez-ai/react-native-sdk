# EdgeZ desktop example

The desktop examples reuse the Expo example's Nodes, Messages, and Settings
screens while keeping native desktop toolchains isolated from Expo. macOS and
Windows use separate hosts because their currently supported React Native
versions do not overlap.

## macOS

Requirements: macOS 14 or newer, Xcode with the macOS SDK, CocoaPods, and
Node.js 20.19.4 or newer.

```sh
npm install
npx pod-install macos
npm run start
# In a second terminal:
npm run macos
```

Create a standalone Release build with:

```sh
npm run build:macos
```

The app is sandboxed and includes the Bluetooth entitlement and usage text.

## Windows

The Windows host is in [`windows-app`](windows-app/) and uses React Native
0.84.1 with React Native Windows 0.84.0.

The official React Native Windows initializer requires Windows. Run it once
after installing dependencies; the setup script also adds the required
Bluetooth capability to the generated package manifest.

```powershell
cd windows-app
npm install
npm run windows:init
npm run start
# In a second terminal:
npm run windows
```

Create a Release build with:

```powershell
npm run build:windows
```

The generated `windows-app/windows/` project is intentionally ignored. It is
generated from the pinned `react-native-windows` template; the SDK's own
Windows native library under `../windows` is committed and autolinked.

## Desktop feature status

BLE discovery, connection, EdgeZ framing, mesh setup, Nodes, Settings, and text
messages are implemented on macOS and Windows. Android remains the reference
implementation for OTA, notifications, location, and recorded voice; those
methods explicitly return `not_available` or `false` on desktop.
