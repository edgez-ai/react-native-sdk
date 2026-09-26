# Changelog

## 0.1.10

- Let Android apps select 115200, 230400, 460800, or 921600 baud for each
  ESP32 flash job and carry the validated choice to the remote runtime.

## 0.1.9

- Handle explicit ESP32 reset commands from the flash runtime and execute each
  timing-sensitive CP210x DTR/RTS sequence atomically through Android USB Host.
  The runtime waits for the result before starting esptool, removing WebSocket
  round-trip gaps between toggles while keeping the flash flow server-controlled.

## 0.1.8

- Confirm managed USB tunnel readiness from the native server's persistent
  status as well as its event stream, so a React Native startup race cannot
  prevent `flash.start` from being sent after USB/IP attaches.
- Preserve the native tunnel's connected state while flash status messages are
  received and remove a race that could overwrite it with `connecting`.

## 0.1.7

- Allow up to two minutes for a cold organization USB runtime to complete its
  WebSocket upgrade, cancel pending upgrades cleanly, and log the Android
  WebSocket/local-socket lifecycle for diagnostics.

## 0.1.6

- Omit stored cookies when exchanging an Appwrite JWT for a managed USB flash
  session, avoiding Appwrite 2.x's conflicting-authentication rejection.

## 0.1.5

- Added managed ESP32 flashing from a versioned GitHub release URL. The mobile
  client sends only the asset URL and GitHub-published SHA-256 to the runtime;
  the runtime downloads and verifies the firmware before flashing.

## 0.1.4

- Added an Android system firmware picker, on-device firmware size/SHA-256
  inspection, typed USB device discovery, and a managed end-to-end ESP32,
  ESP32-S3, and ESP32-C3 Type-C flashing operation.
- Parse runtime flash status/log messages into typed SDK events and reliably
  close the USB export after a managed flash finishes or fails.

- Added an Android userspace USB/IP server for securely exporting attached
  ESP32 serial adapters, SEGGER J-Link probes, and OpenOCD-compatible USB
  devices to an external flashing service.
- Added an authenticated binary WebSocket bridge between the Android USB/IP
  server and an external flashing service.
- Added managed Appwrite flash sessions that exchange an application JWT for a
  short-lived, organization-scoped WebSocket credential.

## 0.1.3

- Added 23 named Organic Maps point icons for animals, people, vehicles, and IoT
  devices. The selected marker color now tints the icon silhouette.

## 0.1.2

- Added native geofence lines to the Android Organic Maps view. Boundaries now
  move with the map renderer while panning and zooming.

## 0.1.1

- Added an Android Organic Maps view with mesh-node markers, offline map
  downloads, camera controls, themes, 2D/3D perspective, and satellite modes.
- Added an Organic Maps tab and persistent Expo prebuild configuration to the
  Android example.
- Fixed first-load rendering, gesture camera jumps, and downloader crashes in
  the React Native Android Organic Maps integration.

## 0.1.0

- Initial EdgeZ React Native SDK with Android, macOS, and Windows BLE transports.
- Added HaLow mesh initialization, encrypted messaging, node discovery, GPS,
  sensor data, provisioning, OTA, voice, and channel-management APIs.
- Added Expo Android and native macOS and Windows example applications.
- Added authenticated BLE reconnect support and Windows diagnostic logging.
