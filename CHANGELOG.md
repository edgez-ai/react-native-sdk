# Changelog

## 0.1.30

- Treat empty ESP-IDF BLE and SoftAP provisioning scans as a normal empty
  result instead of exposing native Java errors to applications.
- Prevent a closed USB flash WebSocket from crashing Android while the local
  CMSIS-DAP programmer reports its final status, and avoid reconnecting USB/IP
  to a WebSocket that has already closed.

## 0.1.29

- Preserve nullable latitude and longitude values in the unified provisioning
  configuration type for compatibility with applications that clear a saved
  fixed location during provisioning.

## 0.1.28

- Use `@orbital-systems/react-native-esp-idf-provisioning` as the single ESP-IDF
  provisioning implementation for both ESP32 BLE and H7608 SoftAP transports.
- Remove the SDK's dedicated H7608 Android Wi-Fi/HTTP transport and protocol
  client while retaining H7608 UI metadata and configuration normalization.

## 0.1.24

- Recover nRF54L CMSIS-DAP connections with nRESET pulses, repeated SWD setup,
  sticky-error clearing before DP bank selection, and core-halt retries.
- Report the failing SWD request and setup stage when target initialization
  cannot be recovered.

## 0.1.23

- Preserve the authenticated flash WebSocket while intentionally closing the
  local USB/IP socket to hand a CMSIS-DAP probe to the Android programmer.

## 0.1.22

- Add a backend-controlled Android CMSIS-DAP accelerator for nRF54L15. The
  runtime downloads and verifies the release asset, streams it to the SDK, and
  receives block-level programming and read-back verification progress.
- Run the nRF54L15 flash algorithm locally on the target through CMSIS-DAP so
  SWD operations no longer incur a WebSocket round trip.

## 0.1.21

- Add the fixed `nrf54l15-openocd` managed release-flash flow for CMSIS-DAP
  probes while retaining the existing J-Link API.

## 0.1.19

- Keep optional USB flash fields absent across the Android native bridge so
  J-Link and OpenOCD jobs do not receive esptool-only defaults.

## 0.1.18

- Align the managed nRF54L15 flow with the deployed `nrf54l15-jlink` runtime
  profile name.

## 0.1.17

- Add a managed nRF54L15 J-Link release flashing flow using the runtime-owned
  `nrf54-jlink` profile and SHA-256-verified GitHub release assets.

## 0.1.16

- Add a check-only app bundle update API so applications can ask the user
  before downloading and staging an update.
- Register the native bundle runtime in debug builds, while continuing to load
  JavaScript from Metro.

## 0.1.15

- Require app bundle manifests to be signed by the same certificate as the
  installed Android APK before downloading or activating an update.

## 0.1.14

- Add SHA-256-verified Android React Native bundle updates through the existing EdgeZ
  firmware OTA release proxy.
- Select staged bundles before React starts, reject incompatible native runtime
  versions, and roll back automatically when a new bundle does not report a
  healthy first launch.

## 0.1.13

- Add an ESP32/esptool-only USB/IP fast path that queues CP210x bulk writes on
  Android while the runtime completes their local USB/IP submissions, removing
  a WAN round trip from every small serial write.
- Keep device reads and control transfers as ordering barriers backed by real
  USB results. J-Link and OpenOCD continue to use strict USB/IP behavior.

## 0.1.12

- Queue Android USB/IP responses independently from WebSocket transmission and
  coalesce up to 256 KiB of stream data for each WebSocket send without changing
  USB/IP byte ordering.
- Log five-second USB/IP transport metrics on Android, including directional
  throughput, frame and batch counts, queue high-water marks, local write and
  WebSocket send latency, OkHttp queue size, and backpressure time.

## 0.1.11

- Keep an active ESP32 flash running while esptool continues to report progress,
  using a 90-second inactivity watchdog instead of terminating every job at the
  previous ten-minute deadline. Retain a 30-minute absolute safety ceiling.
- Move WebSocket-to-USB writes onto an ordered background queue so device writes
  cannot block USB ACK reads or asynchronous WebSocket ACK transmission.

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
# 0.1.25

- Added a UI-independent provisioning manager for ESP32, nRF54, and HT-H7608,
  including upstream Wi-Fi scanning, persistence checks, and disconnect cleanup.
- Added Android app-scoped H7608 SoftAP connections. Provisioning sockets are
  pinned to local Wi-Fi while Appwrite traffic retains the phone's default route.

# 0.1.26

- Added nRF54L CTRL-AP recovery before CMSIS-DAP flashing when access-port
  protection is enabled, with complete erase-state handling and safe reconnects.
- Moved remaining device-specific provisioning payload normalization and UI
  capability metadata into the shared provisioning API.
- Added an Expo config plugin that owns the BLE and SoftAP provisioning native
  setup, so consuming applications no longer declare those libraries directly.

# 0.1.27

- Switched H7608 onboarding to the ESP-IDF Security 0 SoftAP wire protocol,
  including standard session, Wi-Fi scan, Wi-Fi config, and custom MQTT config
  endpoints.
- Kept H7608 provisioning requests pinned to the app-scoped local network so
  unrelated application traffic retains the phone's default Internet route.
