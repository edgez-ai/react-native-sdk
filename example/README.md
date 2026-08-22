# EdgeZ Expo example

This app follows the Expo development-client structure used by
`template-iot-prov`. It demonstrates BLE discovery and connection, mesh
initialization, encrypted conversations, device settings, and OTA capability
checks. The Nodes and Settings tabs mirror the Flutter example's channel-grouped
node list, public talkgroups, routes, user/location setup, mesh configuration,
device GPS/geofence, sensor, upstream Wi-Fi, and sleep controls.
The Android Map tab uses the same EdgeZ Organic Maps engine as the Flutter
example, including mesh-node markers, day/night and 2D/3D controls, and offline
region downloads. It requires Android API 26 or newer.

Expo Go cannot load the EdgeZ Android native module. Build a development
client once, then use the normal Expo development server:

```sh
npm install
npm run android
npm run start
```

The local `file:..` SDK link is configured through `metro.config.js`; run
`npm install` in this directory whenever the SDK's runtime dependencies change.

Open the generated `example/android` directory in Android Studio. The example's
postinstall and Expo config plugins resolve Node from `NODE_BINARY`, standard
Homebrew locations, or the current user's NVM installation so Gradle sync does
not depend on Android Studio inheriting a shell `PATH`.

For EAS, run `eas build --profile development --platform android`.
