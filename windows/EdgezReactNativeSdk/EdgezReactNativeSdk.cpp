#include "pch.h"
#include "EdgezReactNativeSdk.h"

namespace winrt::EdgezReactNativeSdk
{
namespace Bluetooth = Windows::Devices::Bluetooth;
namespace Advertisement = Windows::Devices::Bluetooth::Advertisement;
namespace Gatt = Windows::Devices::Bluetooth::GenericAttributeProfile;
namespace Enumeration = Windows::Devices::Enumeration;
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
    ConnectAsync(address, promise, true);
  } catch (...) {
    EmitLog("BLE connection rejected: invalid scanned device ID");
    promise.Reject("Invalid BLE device ID; scan again before connecting");
  }
}

winrt::fire_and_forget EdgezReactNativeSdk::ConnectAsync(
    uint64_t address,
    React::ReactPromise<void> promise,
    bool allowAssociationReset) noexcept {
  Enumeration::DeviceInformationPairing pairing{nullptr};
  bool usedExistingAssociation = false;
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

    pairing = device.DeviceInformation().Pairing();
    if (!pairing.IsPaired()) {
      if (!pairing.CanPair()) {
        promise.Reject("Windows reports that this BLE device cannot be paired");
        Close(true);
        co_return;
      }

      EmitLog("Pairing BLE device with Windows");
      auto customPairing = pairing.Custom();
      auto pairingRequested = customPairing.PairingRequested(
        winrt::auto_revoke,
        [](Enumeration::DeviceInformationCustomPairing const &,
           Enumeration::DevicePairingRequestedEventArgs const &args) {
          if (args.PairingKind() == Enumeration::DevicePairingKinds::ConfirmOnly) args.Accept();
        });
      auto pairingResult = co_await customPairing.PairAsync(Enumeration::DevicePairingKinds::ConfirmOnly);
      if (!isCurrentConnection()) { promise.Reject("BLE disconnected during pairing"); co_return; }
      auto pairingStatus = pairingResult.Status();
      if (pairingStatus != Enumeration::DevicePairingResultStatus::Paired &&
          pairingStatus != Enumeration::DevicePairingResultStatus::AlreadyPaired) {
        auto status = std::to_string(static_cast<int32_t>(pairingStatus));
        EmitLog("Windows BLE pairing failed; status=" + status);
        promise.Reject(("Windows BLE pairing failed; status=" + status).c_str());
        Close(true);
        co_return;
      }
      EmitLog("Windows BLE pairing completed");
      co_await winrt::resume_after(std::chrono::milliseconds(750));
      if (!isCurrentConnection()) { promise.Reject("BLE disconnected after pairing"); co_return; }
    } else {
      usedExistingAssociation = true;
      EmitLog("Windows reports an existing BLE pairing association");
    }

    auto cacheMode = usedExistingAssociation
      ? Bluetooth::BluetoothCacheMode::Cached
      : Bluetooth::BluetoothCacheMode::Uncached;
    EmitLog(usedExistingAssociation
      ? "Discovering EdgeZ GATT service using the Windows cache"
      : "Discovering EdgeZ GATT service without a stale Windows cache");
    Gatt::GattDeviceServicesResult services{nullptr};
    for (int attempt = 1; attempt <= 6; ++attempt) {
      winrt::hresult failureCode = S_OK;
      winrt::hstring failureMessage;
      try {
        services = co_await device.GetGattServicesForUuidAsync(
          ShortUuid(0xfff0), cacheMode);
      } catch (winrt::hresult_error const &error) {
        failureCode = error.code();
        failureMessage = error.message();
      }
      if (!isCurrentConnection()) {
        EmitLog("BLE setup stopped because Windows disconnected the device");
        promise.Reject("BLE disconnected during GATT service discovery");
        co_return;
      }
      if (device.ConnectionStatus() == Bluetooth::BluetoothConnectionStatus::Disconnected) {
        throw winrt::hresult_error(HRESULT_FROM_WIN32(ERROR_DEVICE_NOT_CONNECTED),
          L"Windows disconnected the BLE device during service discovery");
      }

      if (failureCode >= 0 && services &&
          services.Status() == Gatt::GattCommunicationStatus::Success &&
          services.Services().Size() > 0) break;

      if (attempt == 6) {
        if (failureCode < 0) throw winrt::hresult_error(failureCode, failureMessage);
        auto status = services ? static_cast<int32_t>(services.Status()) : -1;
        throw winrt::hresult_error(HRESULT_FROM_WIN32(ERROR_NOT_READY),
          winrt::to_hstring("EdgeZ BLE service discovery failed; status=" + std::to_string(status)));
      }

      auto detail = failureCode < 0
        ? winrt::to_string(failureMessage)
        : "status=" + std::to_string(services ? static_cast<int32_t>(services.Status()) : -1);
      EmitLog("BLE security/GATT not ready; retry=" + std::to_string(attempt) + " " + detail);
      co_await winrt::resume_after(std::chrono::milliseconds(500));
      if (!isCurrentConnection()) { promise.Reject("BLE disconnected during GATT retry"); co_return; }
    }
    auto service = services.Services().GetAt(0);
    auto characteristics = co_await service.GetCharacteristicsAsync(cacheMode);
    if (!isCurrentConnection()) { promise.Reject("BLE disconnected during characteristic discovery"); co_return; }
    if (characteristics.Status() != Gatt::GattCommunicationStatus::Success) {
      EmitLog("EdgeZ BLE characteristic discovery failed; status=" +
              std::to_string(static_cast<int32_t>(characteristics.Status())));
      promise.Reject("Could not discover EdgeZ BLE characteristics"); Close(true); co_return;
    }
    Gatt::GattCharacteristic rx{nullptr};
    Gatt::GattCharacteristic ota{nullptr};
    std::vector<Gatt::GattCharacteristic> notifications;
    for (auto const &characteristic : characteristics.Characteristics()) {
      auto uuid = characteristic.Uuid();
      if (uuid == ShortUuid(0xfff1)) rx = characteristic;
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
    if (allowAssociationReset && usedExistingAssociation && pairing) {
      EmitLog("Existing Windows BLE pairing association is unusable; resetting it once");
      ResetAssociationAndReconnectAsync(address, promise, pairing);
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

winrt::fire_and_forget EdgezReactNativeSdk::ResetAssociationAndReconnectAsync(
    uint64_t address,
    React::ReactPromise<void> promise,
    Enumeration::DeviceInformationPairing pairing) noexcept {
  Close(false);
  auto resetGeneration = m_connectionGeneration.load(std::memory_order_acquire);
  auto isCurrentReset = [this, resetGeneration]() noexcept {
    return resetGeneration == m_connectionGeneration.load(std::memory_order_acquire);
  };
  try {
    auto result = co_await pairing.UnpairAsync();
    if (!isCurrentReset()) { promise.Reject("BLE pairing reset was superseded"); co_return; }
    auto status = result.Status();
    EmitLog("Windows BLE unpair completed; status=" + std::to_string(static_cast<int32_t>(status)));
    if (status != Enumeration::DeviceUnpairingResultStatus::Unpaired &&
        status != Enumeration::DeviceUnpairingResultStatus::AlreadyUnpaired) {
      promise.Reject(("Could not reset the Windows BLE pairing association; status=" +
                      std::to_string(static_cast<int32_t>(status))).c_str());
      Close(true);
      co_return;
    }

    co_await winrt::resume_after(std::chrono::milliseconds(500));
    if (!isCurrentReset()) { promise.Reject("BLE pairing retry was superseded"); co_return; }
    EmitLog("Retrying BLE connection with a fresh Windows pairing association");
    ConnectAsync(address, promise, false);
  } catch (winrt::hresult_error const &error) {
    EmitLog("Windows BLE pairing association reset failed: " + winrt::to_string(error.message()));
    promise.Reject(error.message().c_str());
    Close(true);
  } catch (...) {
    EmitLog("Windows BLE pairing association reset failed with an unexpected native error");
    promise.Reject("Unexpected Windows BLE pairing reset error");
    if (isCurrentReset()) Close(true);
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

void EdgezReactNativeSdk::InitializeMesh(React::JSValueObject &&arguments, React::ReactPromise<void> &&promise) noexcept { QueuePacket(arguments, promise); }
void EdgezReactNativeSdk::SendPacket(React::JSValueObject &&arguments, React::ReactPromise<void> &&promise) noexcept { QueuePacket(arguments, promise); }

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
    uint32_t maximum = 20;
    if (service.Session()) maximum = std::max<uint32_t>(20, service.Session().MaxPduSize() - 3);
    for (size_t offset = 0; offset < frame.size(); offset += maximum) {
      auto end = std::min(frame.size(), offset + maximum);
      std::vector<uint8_t> chunk(frame.begin() + offset, frame.begin() + end);
      auto result = co_await rx.WriteValueWithResultAsync(Buffer(chunk), Gatt::GattWriteOption::WriteWithResponse);
      if (writeGeneration != m_connectionGeneration.load(std::memory_order_acquire)) {
        promise.Reject("BLE disconnected during control write");
        co_return;
      }
      if (result.Status() != Gatt::GattCommunicationStatus::Success) {
        EmitLog("BLE control write failed; status=" + std::to_string(static_cast<int32_t>(result.Status())));
        promise.Reject("BLE control write failed");
        co_return;
      }
    }
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
