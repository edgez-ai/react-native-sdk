#include "pch.h"
#include "EdgezReactNativeSdk.h"

namespace winrt::EdgezReactNativeSdk
{
namespace Bluetooth = Windows::Devices::Bluetooth;
namespace Advertisement = Windows::Devices::Bluetooth::Advertisement;
namespace Gatt = Windows::Devices::Bluetooth::GenericAttributeProfile;
namespace Enumeration = Windows::Devices::Enumeration;
namespace Metadata = Windows::Foundation::Metadata;
namespace Streams = Windows::Storage::Streams;

static constexpr size_t MaximumPacketLength = 512;
static constexpr uintmax_t MaximumDiagnosticLogLength = 2 * 1024 * 1024;

static std::filesystem::path DiagnosticLogPath() {
  std::vector<wchar_t> localAppData(32768);
  auto length = GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData.data(), static_cast<DWORD>(localAppData.size()));
  auto directory = length > 0 && length < localAppData.size()
    ? std::filesystem::path{localAppData.data()}
    : std::filesystem::temp_directory_path();
  directory /= L"EdgezWindowsExample";
  std::filesystem::create_directories(directory);
  return directory / L"edgez-windows.log";
}

static std::string DiagnosticLogPathString() noexcept {
  try {
    return winrt::to_string(winrt::hstring{DiagnosticLogPath().c_str()});
  } catch (...) {
    return "%LOCALAPPDATA%\\EdgezWindowsExample\\edgez-windows.log";
  }
}

static void WriteDiagnosticLog(std::string const &message) noexcept {
  static std::mutex logMutex;
  try {
    std::scoped_lock lock(logMutex);
    auto path = DiagnosticLogPath();
    std::error_code error;
    if (std::filesystem::exists(path, error) && std::filesystem::file_size(path, error) >= MaximumDiagnosticLogLength) {
      auto previous = path;
      previous += L".1";
      std::filesystem::remove(previous, error);
      error.clear();
      std::filesystem::rename(path, previous, error);
    }

    std::ofstream stream(path, std::ios::app);
    if (!stream) return;
    auto now = std::time(nullptr);
    std::tm utc{};
    gmtime_s(&utc, &now);
    stream << std::put_time(&utc, "%Y-%m-%dT%H:%M:%SZ") << " " << message << '\n';
  } catch (...) {}
}

static winrt::guid ShortUuid(uint32_t value) {
  return Bluetooth::BluetoothUuidHelper::FromShortId(value);
}

static std::string AddressString(uint64_t address) {
  std::ostringstream stream;
  stream << std::uppercase << std::hex << std::setfill('0') << std::setw(12) << address;
  return stream.str();
}

static Streams::IBuffer Buffer(std::vector<uint8_t> const &bytes) {
  Streams::DataWriter writer;
  writer.WriteBytes(bytes);
  return writer.DetachBuffer();
}

static Windows::Foundation::IAsyncOperation<Bluetooth::BluetoothLEDevice> OpenAssociatedDeviceAsync(
    Microsoft::ReactNative::ReactDispatcher const &uiDispatcher,
    winrt::hstring const &deviceId) {
  if (!uiDispatcher) {
    throw winrt::hresult_error(E_UNEXPECTED, L"Windows UI dispatcher is unavailable for BLE association access");
  }

  // Microsoft requires FromIdAsync to be initiated on the UI thread because
  // Windows may need to prompt for device access. Keep the WinRT operation and
  // its result alive while this coroutine resumes on the worker thread.
  struct OpenState {
    winrt::handle completed{CreateEvent(nullptr, true, false, nullptr)};
    Windows::Foundation::IAsyncOperation<Bluetooth::BluetoothLEDevice> operation{nullptr};
    Bluetooth::BluetoothLEDevice device{nullptr};
    winrt::hresult error{S_OK};
    winrt::hstring errorMessage;
  };
  auto state = std::make_shared<OpenState>();
  if (!state->completed) {
    throw winrt::hresult_error(HRESULT_FROM_WIN32(GetLastError()), L"Could not create BLE association wait handle");
  }

  uiDispatcher.Post([state, deviceId]() noexcept {
    try {
      state->operation = Bluetooth::BluetoothLEDevice::FromIdAsync(deviceId);
      state->operation.Completed([state](auto const &operation, Windows::Foundation::AsyncStatus status) noexcept {
        try {
          if (status != Windows::Foundation::AsyncStatus::Completed) {
            auto error = operation.ErrorCode();
            if (!FAILED(error)) error = E_ABORT;
            throw winrt::hresult_error(error, L"Windows could not open the paired BLE association");
          }
          state->device = operation.GetResults();
        } catch (winrt::hresult_error const &error) {
          state->error = error.code();
          state->errorMessage = error.message();
        } catch (...) {
          state->error = E_FAIL;
          state->errorMessage = L"Unexpected error opening the paired BLE association";
        }
        SetEvent(state->completed.get());
      });
    } catch (winrt::hresult_error const &error) {
      state->error = error.code();
      state->errorMessage = error.message();
      SetEvent(state->completed.get());
    } catch (...) {
      state->error = E_FAIL;
      state->errorMessage = L"Unexpected error starting paired BLE association access";
      SetEvent(state->completed.get());
    }
  });

  co_await winrt::resume_on_signal(state->completed.get());
  if (FAILED(state->error)) throw winrt::hresult_error(state->error, state->errorMessage);
  co_return state->device;
}

static std::string ConnectionParametersDescription(Bluetooth::BluetoothLEDevice const &device) {
  auto parameters = device.GetConnectionParameters();
  return "interval=" + std::to_string(parameters.ConnectionInterval()) +
    " latency=" + std::to_string(parameters.ConnectionLatency()) +
    " timeout=" + std::to_string(parameters.LinkTimeout());
}

static std::string PhyInfoDescription(Bluetooth::BluetoothLEConnectionPhyInfo const &info) {
  if (info.IsUncoded2MPhy()) return "2M";
  if (info.IsUncoded1MPhy()) return "1M";
  if (info.IsCodedPhy()) return "coded";
  return "unknown";
}

static std::string ConnectionPhyDescription(Bluetooth::BluetoothLEDevice const &device) {
  auto phy = device.GetConnectionPhy();
  return "tx=" + PhyInfoDescription(phy.TransmitInfo()) +
    " rx=" + PhyInfoDescription(phy.ReceiveInfo());
}

std::string RNGetRandomValues::GetRandomBase64(double byteLength) noexcept {
  try {
    auto length = static_cast<uint32_t>(std::clamp(byteLength, 0.0, 65536.0));
    auto random = Windows::Security::Cryptography::CryptographicBuffer::GenerateRandom(length);
    return winrt::to_string(Windows::Security::Cryptography::CryptographicBuffer::EncodeToBase64String(random));
  } catch (...) {
    std::terminate();
  }
}

void EdgezReactNativeSdk::Initialize(React::ReactContext const &reactContext) noexcept {
  m_context = reactContext;
  WriteDiagnosticLog("Windows SDK initialized; diagnostic log=" + DiagnosticLogPathString());
}

void EdgezReactNativeSdk::Emit(React::JSValueObject &&event) noexcept {
  m_context.EmitJSEvent(L"RCTDeviceEventEmitter", L"EdgezMeshEvent", std::move(event));
}

void EdgezReactNativeSdk::EmitLog(std::string const &message) noexcept {
  WriteDiagnosticLog(message);
  Emit({{"type", "log"}, {"log", message}});
}

void EdgezReactNativeSdk::StartBleScan(React::JSValueObject &&, React::ReactPromise<void> &&promise) noexcept {
  try {
    if (m_watcher && m_watcher.Status() == Advertisement::BluetoothLEAdvertisementWatcherStatus::Started) m_watcher.Stop();
    m_watcher = Advertisement::BluetoothLEAdvertisementWatcher{};
    m_watcher.ScanningMode(Advertisement::BluetoothLEScanningMode::Active);
    m_watcher.AdvertisementFilter().Advertisement().ServiceUuids().Append(ShortUuid(0xfff0));
    m_watcher.Received([this](auto const &, Advertisement::BluetoothLEAdvertisementReceivedEventArgs const &args) {
      auto now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
      Emit({{"type", "bleDevice"}, {"bleDevice", React::JSValueObject{
        {"id", AddressString(args.BluetoothAddress())}, {"name", winrt::to_string(args.Advertisement().LocalName())},
        {"rssi", static_cast<double>(args.RawSignalStrengthInDBm())}, {"lastSeenMs", static_cast<double>(now)}}}});
    });
    m_watcher.Stopped([this](auto const &, Advertisement::BluetoothLEAdvertisementWatcherStoppedEventArgs const &args) {
      if (args.Error() != Bluetooth::BluetoothError::Success) EmitLog("BLE scan stopped with an error");
    });
    m_watcher.Start();
    EmitLog("BLE scan started");
    promise.Resolve();
  } catch (winrt::hresult_error const &error) {
    EmitLog("BLE scan failed: " + winrt::to_string(error.message()));
    promise.Reject(error.message().c_str());
  }
}

void EdgezReactNativeSdk::StopBleScan(React::JSValueObject &&, React::ReactPromise<void> &&promise) noexcept {
  if (m_watcher && m_watcher.Status() == Advertisement::BluetoothLEAdvertisementWatcherStatus::Started) m_watcher.Stop();
  EmitLog("BLE scan stopped");
  promise.Resolve();
}

void EdgezReactNativeSdk::ConnectBle(React::JSValueObject &&arguments, React::ReactPromise<void> &&promise) noexcept {
  auto found = arguments.find("deviceId");
  if (found == arguments.end() || found->second.AsString().empty()) { promise.Reject("Missing BLE device ID"); return; }
  try {
    auto address = std::stoull(found->second.AsString(), nullptr, 16);
    if (m_watcher && m_watcher.Status() == Advertisement::BluetoothLEAdvertisementWatcherStatus::Started) m_watcher.Stop();
    ConnectAsync(address, promise);
  } catch (...) {
    EmitLog("BLE connection rejected: invalid scanned device ID");
    promise.Reject("Invalid BLE device ID; scan again before connecting");
  }
}

winrt::fire_and_forget EdgezReactNativeSdk::ConnectAsync(
    uint64_t address,
    React::ReactPromise<void> promise) noexcept {
  Close(false);
  auto connectionGeneration = m_connectionGeneration.load(std::memory_order_acquire);
  auto isCurrentConnection = [this, connectionGeneration]() noexcept {
    return connectionGeneration == m_connectionGeneration.load(std::memory_order_acquire);
  };
  try {
    EmitLog("Connecting BLE " + AddressString(address));
    auto device = co_await Bluetooth::BluetoothLEDevice::FromBluetoothAddressAsync(address);
    if (!isCurrentConnection()) { promise.Reject("BLE connection attempt was superseded"); co_return; }
    if (!device) { promise.Reject("BLE device was not found; scan first"); co_return; }
    m_device = device;

    // Never delete or replace a Windows association during connection setup.
    // GATT access is the source of truth: FFF1 requests authenticated security
    // and Windows restores an existing bond or presents its native PIN UI.
    auto pairing = device.DeviceInformation().Pairing();
    Gatt::GattSession associationSession{nullptr};
    if (!pairing.IsPaired()) {
      EmitLog("No Windows BLE pairing association; authenticated FFF1 access will request the native PIN dialog");
    } else {
      auto protection = pairing.ProtectionLevel();
      EmitLog("Windows reports an existing BLE pairing association; protection=" +
        std::to_string(static_cast<int32_t>(protection)));
      // DeviceInformationPairing::ProtectionLevel describes the Windows
      // association and can report Encryption even for a bond whose BLE keys
      // satisfy the authenticated FFF1 characteristic. Do not destroy a
      // working bond based on this metadata. The protected FFF1 write is the
      // authoritative security check and reuses the stored keys silently.

      // Reopen paired devices by their Windows DeviceInformation ID. This is
      // the association-backed GATT client path documented by Microsoft and
      // ensures Windows loads the stored LE keys before the firmware starts
      // its short bond-restore grace period. Opening only by MAC address can
      // create a transient cache object that knows IsPaired but has not yet
      // attached the persisted security context.
      auto deviceId = device.DeviceInformation().Id();
      EmitLog("Opening existing Windows BLE association by device ID");
      auto associatedDevice = co_await OpenAssociatedDeviceAsync(m_context.UIDispatcher(), deviceId);
      if (!isCurrentConnection()) {
        if (associatedDevice) associatedDevice.Close();
        promise.Reject("BLE connection attempt was superseded");
        co_return;
      }
      if (!associatedDevice) {
        throw winrt::hresult_error(HRESULT_FROM_WIN32(ERROR_NOT_READY),
          L"Windows could not reopen the paired BLE association");
      }
      device = associatedDevice;
      m_device = device;
      EmitLog("Existing Windows BLE association opened for authenticated GATT access");

      // A cached GetGattServicesAsync call can complete before Windows has
      // re-established the physical link. Create and retain the GATT session
      // first; MaintainConnection is the Windows API that requests an actual
      // connection independently of whether service metadata is cached.
      associationSession = co_await Gatt::GattSession::FromDeviceIdAsync(device.BluetoothDeviceId());
      if (!isCurrentConnection()) {
        if (associationSession) associationSession.Close();
        promise.Reject("BLE connection attempt was superseded");
        co_return;
      }
      if (!associationSession) {
        throw winrt::hresult_error(HRESULT_FROM_WIN32(ERROR_NOT_READY),
          L"Windows could not create a GATT session for the paired BLE device");
      }
      associationSession.MaintainConnection(true);
      m_session = associationSession;
      EmitLog("Existing Windows BLE GATT session retained; requesting a live connection");

      // Android waits for STATE_CONNECTED before it requests high connection
      // priority, negotiates the link, and starts service discovery. WinRT's
      // MaintainConnection has no awaitable completion, so wait for the
      // BluetoothLEDevice status instead of issuing GATT commands while its
      // connection parameters are still all zero.
      for (int attempt = 0;
           attempt < 120 && device.ConnectionStatus() != Bluetooth::BluetoothConnectionStatus::Connected;
           ++attempt) {
        co_await winrt::resume_after(std::chrono::milliseconds(100));
        if (!isCurrentConnection()) {
          promise.Reject("BLE connection attempt was superseded");
          co_return;
        }
      }
      if (device.ConnectionStatus() != Bluetooth::BluetoothConnectionStatus::Connected) {
        throw winrt::hresult_error(HRESULT_FROM_WIN32(ERROR_TIMEOUT),
          L"Windows did not establish the paired BLE link within 12 seconds");
      }
      EmitLog("Existing Windows BLE physical link connected; " + ConnectionParametersDescription(device));
    }

    // Enumerating the complete service table is more compatible with Windows
    // BLE drivers than the UUID-filtered GATT command. An existing association
    // uses Uncached so this operation establishes and verifies a live encrypted
    // link instead of returning metadata while ConnectionStatus is still false.
    auto cacheMode = associationSession
      ? Bluetooth::BluetoothCacheMode::Uncached
      : Bluetooth::BluetoothCacheMode::Cached;
    EmitLog(associationSession
      ? "Connecting through the existing Windows BLE association and refreshing the GATT service table"
      : "Enumerating the Windows GATT service table");
    Gatt::GattDeviceServicesResult services{nullptr};
    Gatt::GattDeviceService service{nullptr};
    for (int attempt = 1; attempt <= 6; ++attempt) {
      winrt::hresult failureCode = S_OK;
      winrt::hstring failureMessage;
      try {
        services = co_await device.GetGattServicesAsync(cacheMode);
      } catch (winrt::hresult_error const &error) {
        failureCode = error.code();
        failureMessage = error.message();
      }
      if (!isCurrentConnection()) {
        EmitLog("BLE setup stopped because Windows disconnected the device");
        promise.Reject("BLE disconnected during GATT service discovery");
        co_return;
      }
      service = nullptr;
      if (failureCode >= 0 && services && services.Status() == Gatt::GattCommunicationStatus::Success) {
        for (auto const &candidate : services.Services()) {
          if (candidate.Uuid() == ShortUuid(0xfff0)) { service = candidate; break; }
        }
      }
      if (service) break;

      if (attempt == 6) {
        if (failureCode < 0) throw winrt::hresult_error(failureCode, failureMessage);
        auto status = services ? static_cast<int32_t>(services.Status()) : -1;
        auto count = services ? services.Services().Size() : 0;
        throw winrt::hresult_error(HRESULT_FROM_WIN32(ERROR_NOT_READY),
          winrt::to_hstring("EdgeZ BLE service FFF0 was not discovered; status=" + std::to_string(status) +
            " services=" + std::to_string(count)));
      }

      auto detail = failureCode < 0
        ? winrt::to_string(failureMessage)
        : "status=" + std::to_string(services ? static_cast<int32_t>(services.Status()) : -1) +
          " services=" + std::to_string(services ? services.Services().Size() : 0);
      EmitLog("BLE security/GATT not ready; retry=" + std::to_string(attempt) + " " + detail);
      co_await winrt::resume_after(std::chrono::milliseconds(500));
      if (!isCurrentConnection()) { promise.Reject("BLE disconnected during GATT retry"); co_return; }
    }
    auto openStatus = co_await service.OpenAsync(Gatt::GattSharingMode::SharedReadAndWrite);
    if (!isCurrentConnection()) {
      promise.Reject("BLE disconnected while opening the EdgeZ GATT service");
      co_return;
    }
    if (openStatus != Gatt::GattOpenStatus::Success &&
        openStatus != Gatt::GattOpenStatus::AlreadyOpened) {
      throw winrt::hresult_error(HRESULT_FROM_WIN32(ERROR_NOT_READY),
        winrt::to_hstring("Could not open EdgeZ GATT service; status=" +
          std::to_string(static_cast<int32_t>(openStatus))));
    }
    EmitLog("EdgeZ GATT service opened SharedReadAndWrite; status=" +
      std::to_string(static_cast<int32_t>(openStatus)));

    auto session = service.Session();
    if (!session) {
      throw winrt::hresult_error(HRESULT_FROM_WIN32(ERROR_NOT_READY),
        L"The opened EdgeZ GATT service did not provide a session");
    }
    session.MaintainConnection(true);
    EmitLog("Windows GATT session retained; can_maintain=" +
      std::to_string(session.CanMaintainConnection() ? 1 : 0) +
      " maintain=" + std::to_string(session.MaintainConnection() ? 1 : 0));

    if (session) {
      // Retain the session before registering its callback so every failure
      // path can revoke the handler and close the native connection cleanly.
      m_session = session;
      m_sessionStatusToken = session.SessionStatusChanged(
        [this, connectionGeneration](Gatt::GattSession const &, Gatt::GattSessionStatusChangedEventArgs const &args) {
          if (connectionGeneration != m_connectionGeneration.load(std::memory_order_acquire)) return;
          EmitLog("Windows GATT session status changed; status=" +
            std::to_string(static_cast<int32_t>(args.Status())) +
            " error=" + std::to_string(static_cast<int32_t>(args.Error())));
        });
      m_hasSessionStatusHandler = true;
    }

    if (Metadata::ApiInformation::IsEventPresent(
          L"Windows.Devices.Bluetooth.BluetoothLEDevice", L"ConnectionParametersChanged")) {
      m_connectionParametersToken = device.ConnectionParametersChanged(
        [this, connectionGeneration](Bluetooth::BluetoothLEDevice const &changedDevice, auto const &) {
          if (connectionGeneration != m_connectionGeneration.load(std::memory_order_acquire)) return;
          try {
            EmitLog("Windows BLE parameters changed; " + ConnectionParametersDescription(changedDevice));
          } catch (...) {}
        });
      m_hasConnectionParametersHandler = true;
    }
    if (Metadata::ApiInformation::IsEventPresent(
          L"Windows.Devices.Bluetooth.BluetoothLEDevice", L"ConnectionPhyChanged")) {
      m_connectionPhyToken = device.ConnectionPhyChanged(
        [this, connectionGeneration](Bluetooth::BluetoothLEDevice const &changedDevice, auto const &) {
          if (connectionGeneration != m_connectionGeneration.load(std::memory_order_acquire)) return;
          try {
            EmitLog("Windows BLE PHY changed; " + ConnectionPhyDescription(changedDevice));
          } catch (...) {}
        });
      m_hasConnectionPhyHandler = true;
      try {
        EmitLog("Windows BLE PHY current; " + ConnectionPhyDescription(device));
      } catch (...) {}
    }

    // Windows has already restored the FFF2 CCCD by this point, which means
    // its system GATT cache contains characteristic objects. Read that local
    // snapshot first; GetCharacteristicsAsync can otherwise issue another
    // remote ATT discovery that blocks until Windows tears down the link.
    std::vector<Gatt::GattCharacteristic> discoveredCharacteristics;
    try {
      for (auto const &characteristic : service.GetAllCharacteristics()) {
        discoveredCharacteristics.push_back(characteristic);
      }
      EmitLog("Windows cached GATT characteristics=" + std::to_string(discoveredCharacteristics.size()));
    } catch (winrt::hresult_error const &error) {
      EmitLog("Windows cached characteristic lookup failed: " + winrt::to_string(error.message()));
    }

    auto cachedControl = std::find_if(discoveredCharacteristics.begin(), discoveredCharacteristics.end(), [](auto const &characteristic) {
      return characteristic.Uuid() == ShortUuid(0xfff1);
    });
    auto cachedControlTx = std::find_if(discoveredCharacteristics.begin(), discoveredCharacteristics.end(), [](auto const &characteristic) {
      return characteristic.Uuid() == ShortUuid(0xfff2);
    });
    if (cachedControl == discoveredCharacteristics.end() || cachedControlTx == discoveredCharacteristics.end()) {
      EmitLog("Cached GATT table is missing FFF1/FFF2; requesting characteristics from the device");
      auto characteristics = co_await service.GetCharacteristicsAsync(cacheMode);
      if (!isCurrentConnection()) { promise.Reject("BLE disconnected during characteristic discovery"); co_return; }
      if (characteristics.Status() != Gatt::GattCommunicationStatus::Success) {
        EmitLog("EdgeZ BLE characteristic discovery failed; status=" +
                std::to_string(static_cast<int32_t>(characteristics.Status())));
        promise.Reject("Could not discover EdgeZ BLE characteristics"); Close(true); co_return;
      }
      discoveredCharacteristics.clear();
      for (auto const &characteristic : characteristics.Characteristics()) {
        discoveredCharacteristics.push_back(characteristic);
      }
    }
    Gatt::GattCharacteristic rx{nullptr};
    Gatt::GattCharacteristic ota{nullptr};
    std::vector<Gatt::GattCharacteristic> notifications;
    for (auto const &characteristic : discoveredCharacteristics) {
      auto uuid = characteristic.Uuid();
      if (uuid == ShortUuid(0xfff1)) {
        characteristic.ProtectionLevel(Gatt::GattProtectionLevel::EncryptionAndAuthenticationRequired);
        rx = characteristic;
      }
      if (uuid == ShortUuid(0xfff5)) ota = characteristic;
      if (uuid == ShortUuid(0xfff2) || uuid == ShortUuid(0xfff4) || uuid == ShortUuid(0xfff6) || uuid == ShortUuid(0xfff8)) {
        characteristic.ValueChanged({this, &EdgezReactNativeSdk::HandleValue});
        auto status = co_await characteristic.WriteClientCharacteristicConfigurationDescriptorAsync(
          Gatt::GattClientCharacteristicConfigurationDescriptorValue::Notify);
        if (!isCurrentConnection()) { promise.Reject("BLE disconnected during notification setup"); co_return; }
        if (status == Gatt::GattCommunicationStatus::Success) notifications.push_back(characteristic);
        else EmitLog("BLE notification subscription failed; status=" + std::to_string(static_cast<int32_t>(status)));
      }
    }
    if (!rx) {
      EmitLog("EdgeZ BLE control characteristic FFF1 is unavailable");
      promise.Reject("EdgeZ BLE control characteristic FFF1 is unavailable"); Close(true); co_return;
    }
    if (!isCurrentConnection()) { promise.Reject("BLE disconnected before the control channel became ready"); co_return; }
    m_service = service;
    m_session = session;
    m_rx = rx;
    m_ota = ota;
    m_notifications = std::move(notifications);
    m_connectionStatusToken = device.ConnectionStatusChanged([this, connectionGeneration](Bluetooth::BluetoothLEDevice const &connectedDevice, auto const &) {
      if (connectionGeneration != m_connectionGeneration.load(std::memory_order_acquire)) return;
      if (connectedDevice.ConnectionStatus() == Bluetooth::BluetoothConnectionStatus::Disconnected) {
        EmitLog("BLE disconnected by Windows");
        Close(true);
      }
    });
    m_hasConnectionStatusHandler = true;
    EmitLog("BLE control channel ready");
    Emit({{"type", "connection"}, {"connection", "ble"}});
    Emit({{"type", "ready"}});
    promise.Resolve();
  } catch (winrt::hresult_error const &error) {
    EmitLog("BLE connection failed: " + winrt::to_string(error.message()));
    if (!isCurrentConnection()) {
      promise.Reject("BLE disconnected while setting up the control channel");
      co_return;
    }
    promise.Reject(error.message().c_str());
    Close(true);
  } catch (...) {
    EmitLog("BLE connection failed with an unexpected native error");
    promise.Reject("Unexpected Windows BLE connection error");
    if (isCurrentConnection()) Close(true);
  }
}

void EdgezReactNativeSdk::Disconnect(React::JSValueObject &&, React::ReactPromise<void> &&promise) noexcept {
  if (m_watcher && m_watcher.Status() == Advertisement::BluetoothLEAdvertisementWatcherStatus::Started) m_watcher.Stop();
  EmitLog("BLE disconnect requested");
  Close(true);
  promise.Resolve();
}

void EdgezReactNativeSdk::Close(bool emitDisconnected) noexcept {
  m_connectionGeneration.fetch_add(1, std::memory_order_relaxed);
  m_notifications.clear();
  m_rx = nullptr;
  m_ota = nullptr;
  if (m_device && m_hasConnectionParametersHandler) m_device.ConnectionParametersChanged(m_connectionParametersToken);
  m_hasConnectionParametersHandler = false;
  m_connectionParametersToken = {};
  if (m_device && m_hasConnectionPhyHandler) m_device.ConnectionPhyChanged(m_connectionPhyToken);
  m_hasConnectionPhyHandler = false;
  m_connectionPhyToken = {};
  try {
    if (m_session) {
      if (m_hasSessionStatusHandler) m_session.SessionStatusChanged(m_sessionStatusToken);
      m_hasSessionStatusHandler = false;
      m_sessionStatusToken = {};
      m_session.MaintainConnection(false);
      m_session.Close();
    }
    m_session = nullptr;
  } catch (...) {
    m_session = nullptr;
  }
  m_hasSessionStatusHandler = false;
  m_sessionStatusToken = {};
  if (m_service) m_service.Close();
  m_service = nullptr;
  if (m_device && m_hasConnectionStatusHandler) m_device.ConnectionStatusChanged(m_connectionStatusToken);
  m_hasConnectionStatusHandler = false;
  m_connectionStatusToken = {};
  if (m_device) m_device.Close();
  m_device = nullptr;
  { std::scoped_lock lock(m_frameMutex); m_receive.clear(); m_forwardReceive.clear(); }
  if (emitDisconnected) Emit({{"type", "connection"}, {"connection", "none"}});
}

void EdgezReactNativeSdk::InitializeMesh(React::JSValueObject &&arguments, React::ReactPromise<void> &&promise) noexcept {
  QueuePacket(arguments, promise);
}
void EdgezReactNativeSdk::SendPacket(React::JSValueObject &&arguments, React::ReactPromise<void> &&promise) noexcept {
  QueuePacket(arguments, promise);
}

void EdgezReactNativeSdk::QueuePacket(React::JSValueObject const &arguments, React::ReactPromise<void> const &promise) noexcept {
  auto found = arguments.find("packet");
  if (found == arguments.end()) { promise.Reject("Missing EdgeZ packet"); return; }
  auto const &packet = found->second.AsArray();
  if (packet.empty()) { promise.Reject("Missing EdgeZ packet"); return; }
  if (packet.size() > MaximumPacketLength) { promise.Reject("EdgeZ packet exceeds 512 bytes"); return; }
  if (!m_device || !m_rx) { promise.Reject("BLE control channel is not ready"); return; }
  std::vector<uint8_t> frame{'E', 'Z', static_cast<uint8_t>(packet.size() & 0xff), static_cast<uint8_t>((packet.size() >> 8) & 0xff)};
  frame.reserve(packet.size() + 4);
  for (auto const &value : packet) frame.push_back(static_cast<uint8_t>(value.AsDouble()));
  WriteFrameAsync(std::move(frame), promise);
}

winrt::fire_and_forget EdgezReactNativeSdk::WriteFrameAsync(std::vector<uint8_t> frame, React::ReactPromise<void> promise) noexcept {
  auto writeGeneration = m_connectionGeneration.load(std::memory_order_acquire);
  auto rx = m_rx;
  auto service = m_service;
  try {
    if (!rx || !service) { promise.Reject("BLE control channel is not ready"); co_return; }
    // The firmware control endpoint reassembles the EdgeZ frame across ATT
    // writes. Keep Windows writes at the default-MTU payload size: MaxPduSize
    // can describe a larger session PDU than this characteristic accepts in a
    // single Write Request, which results in ATT Invalid Attribute Value Length.
    constexpr uint32_t maximum = 20;
    EmitLog("BLE control write started; bytes=" + std::to_string(frame.size()) + " chunk=20");
    for (size_t offset = 0; offset < frame.size(); offset += maximum) {
      auto end = std::min(frame.size(), offset + maximum);
      std::vector<uint8_t> chunk(frame.begin() + offset, frame.begin() + end);
      bool written = false;
      // The first protected FFF1 write starts Windows' native PIN ceremony.
      // WriteValueWithResultAsync may return Unreachable immediately while the
      // dialog remains open and the firmware is still completing encryption.
      // Keep the original frame alive for that authentication window instead
      // of requiring JavaScript to manufacture a second INIT_HALOW request.
      auto maximumAttempts = offset == 0 ? 40 : 4;
      for (int attempt = 1; attempt <= maximumAttempts; ++attempt) {
        auto result = co_await rx.WriteValueWithResultAsync(Buffer(chunk), Gatt::GattWriteOption::WriteWithResponse);
        if (writeGeneration != m_connectionGeneration.load(std::memory_order_acquire)) {
          promise.Reject("BLE disconnected during control write");
          co_return;
        }
        if (result.Status() == Gatt::GattCommunicationStatus::Success) {
          written = true;
          break;
        }

        auto protocolError = result.ProtocolError();
        auto protocolErrorCode = protocolError ? static_cast<int32_t>(protocolError.Value()) : -1;
        EmitLog("BLE control write failed; status=" + std::to_string(static_cast<int32_t>(result.Status())) +
          " protocol_error=" + std::to_string(protocolErrorCode) +
          " offset=" + std::to_string(offset) + " attempt=" + std::to_string(attempt));
        auto authenticationStillSettling =
          result.Status() == Gatt::GattCommunicationStatus::Unreachable ||
          (result.Status() == Gatt::GattCommunicationStatus::ProtocolError &&
            (protocolErrorCode == 0x05 || protocolErrorCode == 0x0c || protocolErrorCode == 0x0f));
        if (!authenticationStillSettling || attempt == maximumAttempts) break;
        co_await winrt::resume_after(std::chrono::milliseconds(offset == 0 ? 750 : 500));
        if (writeGeneration != m_connectionGeneration.load(std::memory_order_acquire)) {
          promise.Reject("BLE disconnected while waiting to retry the control write");
          co_return;
        }
      }
      if (!written) {
        promise.Reject("BLE control write failed");
        co_return;
      }
    }
    EmitLog("BLE control write completed; bytes=" + std::to_string(frame.size()));
    promise.Resolve();
  } catch (winrt::hresult_error const &error) {
    EmitLog("BLE control write failed: " + winrt::to_string(error.message()));
    promise.Reject(error.message().c_str());
  } catch (...) {
    EmitLog("BLE control write failed with an unexpected native error");
    promise.Reject("Unexpected Windows BLE control write error");
  }
}

void EdgezReactNativeSdk::HandleValue(Gatt::GattCharacteristic const &sender, Gatt::GattValueChangedEventArgs const &args) noexcept {
  Streams::DataReader reader = Streams::DataReader::FromBuffer(args.CharacteristicValue());
  std::vector<uint8_t> bytes(reader.UnconsumedBufferLength());
  reader.ReadBytes(bytes);
  std::scoped_lock lock(m_frameMutex);
  if (sender.Uuid() == ShortUuid(0xfff2)) AppendFrame(bytes, m_receive, "");
  else if (sender.Uuid() == ShortUuid(0xfff4)) AppendFrame(bytes, m_forwardReceive, "ble_forward");
}

void EdgezReactNativeSdk::AppendFrame(std::vector<uint8_t> const &bytes, std::vector<uint8_t> &accumulator, std::string const &route) noexcept {
  accumulator.insert(accumulator.end(), bytes.begin(), bytes.end());
  while (accumulator.size() >= 4) {
    if (accumulator[0] != 'E' || accumulator[1] != 'Z') { accumulator.erase(accumulator.begin()); continue; }
    size_t length = accumulator[2] | (static_cast<size_t>(accumulator[3]) << 8);
    if (length > MaximumPacketLength) { accumulator.clear(); EmitLog("Discarded an oversized BLE frame"); return; }
    if (accumulator.size() < length + 4) return;
    React::JSValueArray packet;
    packet.reserve(length);
    for (size_t index = 0; index < length; index++) packet.push_back(static_cast<double>(accumulator[index + 4]));
    React::JSValueObject event{{"type", "packet"}, {"packet", std::move(packet)}};
    if (!route.empty()) event["route"] = route;
    Emit(std::move(event));
    accumulator.erase(accumulator.begin(), accumulator.begin() + length + 4);
  }
}

void EdgezReactNativeSdk::IsOtaReady(React::JSValueObject &&, React::ReactPromise<bool> &&promise) noexcept { promise.Resolve(m_device && m_ota); }
void EdgezReactNativeSdk::AbortOta(React::JSValueObject &&, React::ReactPromise<void> &&promise) noexcept { promise.Resolve(); }
void EdgezReactNativeSdk::PerformOta(React::JSValueObject &&, React::ReactPromise<std::string> &&promise) noexcept { promise.Reject("OTA is not available in the desktop transport yet"); }
void EdgezReactNativeSdk::RequestMicrophonePermission(React::JSValueObject &&, React::ReactPromise<bool> &&promise) noexcept { promise.Resolve(false); }
void EdgezReactNativeSdk::RequestNotificationPermission(React::JSValueObject &&, React::ReactPromise<bool> &&promise) noexcept { promise.Resolve(false); }
void EdgezReactNativeSdk::NotificationsAllowed(React::JSValueObject &&, React::ReactPromise<bool> &&promise) noexcept { promise.Resolve(false); }
void EdgezReactNativeSdk::CanUseFullScreenIntent(React::JSValueObject &&, React::ReactPromise<bool> &&promise) noexcept { promise.Resolve(false); }
void EdgezReactNativeSdk::GetBestKnownLocation(React::JSValueObject &&, React::ReactPromise<React::JSValue> &&promise) noexcept { promise.Resolve(React::JSValue{nullptr}); }
void EdgezReactNativeSdk::ClearCallLockScreenPresentation(React::JSValueObject &&, React::ReactPromise<void> &&promise) noexcept { promise.Resolve(); }
void EdgezReactNativeSdk::CancelIncomingCallNotification(React::JSValueObject &&, React::ReactPromise<void> &&promise) noexcept { promise.Resolve(); }
void EdgezReactNativeSdk::ShowIncomingMessageNotification(React::JSValueObject &&, React::ReactPromise<bool> &&promise) noexcept { promise.Resolve(false); }
void EdgezReactNativeSdk::ShowIncomingCallNotification(React::JSValueObject &&, React::ReactPromise<bool> &&promise) noexcept { promise.Resolve(false); }
void EdgezReactNativeSdk::StartVoiceRecording(React::JSValueObject &&, React::ReactPromise<void> &&promise) noexcept { promise.Reject("Voice recording is not available in the desktop transport yet"); }
void EdgezReactNativeSdk::StopVoiceRecording(React::JSValueObject &&, React::ReactPromise<React::JSValue> &&promise) noexcept { promise.Resolve(React::JSValue{nullptr}); }
void EdgezReactNativeSdk::PlayVoiceMessage(React::JSValueObject &&, React::ReactPromise<void> &&promise) noexcept { promise.Reject("Voice playback is not available in the desktop transport yet"); }
void EdgezReactNativeSdk::StartLiveVoiceAudio(React::JSValueObject &&, React::ReactPromise<void> &&promise) noexcept { promise.Reject("Live voice is not available in this release"); }
void EdgezReactNativeSdk::StopLiveVoiceAudio(React::JSValueObject &&, React::ReactPromise<void> &&promise) noexcept { promise.Resolve(); }
void EdgezReactNativeSdk::PlayLiveVoiceAudio(React::JSValueObject &&, React::ReactPromise<void> &&promise) noexcept { promise.Reject("Live voice is not available in this release"); }
void EdgezReactNativeSdk::AddListener(std::string) noexcept {}
void EdgezReactNativeSdk::RemoveListeners(double) noexcept {}

} // namespace winrt::EdgezReactNativeSdk
