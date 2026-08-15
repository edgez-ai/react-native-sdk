# EdgeZ Expo example

This app follows the Expo development-client structure used by
`template-iot-prov`. It demonstrates BLE discovery and connection, mesh
initialization, discovered nodes, encrypted conversations, device settings,
and OTA capability checks.

Expo Go cannot load the EdgeZ Android native module. Build a development
client once, then use the normal Expo development server:

```sh
npm install
npm run android
npm run start
```

Open the generated `example/android` directory in Android Studio. The example's
postinstall and Expo config plugins resolve Node from `NODE_BINARY`, standard
Homebrew locations, or the current user's NVM installation so Gradle sync does
not depend on Android Studio inheriting a shell `PATH`.

For EAS, run `eas build --profile development --platform android`.
