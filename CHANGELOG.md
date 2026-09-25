# Changelog

## Unreleased

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
