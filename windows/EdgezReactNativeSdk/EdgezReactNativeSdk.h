#pragma once

#include "pch.h"
#include "resource.h"
#include "NativeModules.h"

namespace winrt::EdgezReactNativeSdk
{

REACT_MODULE(RNGetRandomValues)
struct RNGetRandomValues
{
  REACT_SYNC_METHOD(GetRandomBase64, L"getRandomBase64")
  std::string GetRandomBase64(double byteLength) noexcept;
};

REACT_MODULE(EdgezReactNativeSdk)
struct EdgezReactNativeSdk
{
  REACT_INIT(Initialize)
  void Initialize(React::ReactContext const &reactContext) noexcept;

  REACT_METHOD(StartBleScan, L"startBleScan")
  void StartBleScan(React::JSValueObject &&arguments, React::ReactPromise<void> &&promise) noexcept;
  REACT_METHOD(StopBleScan, L"stopBleScan")
  void StopBleScan(React::JSValueObject &&arguments, React::ReactPromise<void> &&promise) noexcept;
  REACT_METHOD(ConnectBle, L"connectBle")
  void ConnectBle(React::JSValueObject &&arguments, React::ReactPromise<void> &&promise) noexcept;
  REACT_METHOD(Disconnect, L"disconnect")
  void Disconnect(React::JSValueObject &&arguments, React::ReactPromise<void> &&promise) noexcept;
  REACT_METHOD(InitializeMesh, L"initializeMesh")
  void InitializeMesh(React::JSValueObject &&arguments, React::ReactPromise<void> &&promise) noexcept;
  REACT_METHOD(SendPacket, L"sendPacket")
  void SendPacket(React::JSValueObject &&arguments, React::ReactPromise<void> &&promise) noexcept;

  REACT_METHOD(IsOtaReady, L"isOtaReady")
  void IsOtaReady(React::JSValueObject &&arguments, React::ReactPromise<bool> &&promise) noexcept;
  REACT_METHOD(AbortOta, L"abortOta")
  void AbortOta(React::JSValueObject &&arguments, React::ReactPromise<void> &&promise) noexcept;
  REACT_METHOD(PerformOta, L"performOta")
  void PerformOta(React::JSValueObject &&arguments, React::ReactPromise<std::string> &&promise) noexcept;
  REACT_METHOD(RequestMicrophonePermission, L"requestMicrophonePermission")
  void RequestMicrophonePermission(React::JSValueObject &&arguments, React::ReactPromise<bool> &&promise) noexcept;
  REACT_METHOD(RequestNotificationPermission, L"requestNotificationPermission")
  void RequestNotificationPermission(React::JSValueObject &&arguments, React::ReactPromise<bool> &&promise) noexcept;
  REACT_METHOD(NotificationsAllowed, L"notificationsAllowed")
  void NotificationsAllowed(React::JSValueObject &&arguments, React::ReactPromise<bool> &&promise) noexcept;
  REACT_METHOD(CanUseFullScreenIntent, L"canUseFullScreenIntent")
  void CanUseFullScreenIntent(React::JSValueObject &&arguments, React::ReactPromise<bool> &&promise) noexcept;
  REACT_METHOD(GetBestKnownLocation, L"getBestKnownLocation")
  void GetBestKnownLocation(React::JSValueObject &&arguments, React::ReactPromise<React::JSValue> &&promise) noexcept;
  REACT_METHOD(ClearCallLockScreenPresentation, L"clearCallLockScreenPresentation")
  void ClearCallLockScreenPresentation(React::JSValueObject &&arguments, React::ReactPromise<void> &&promise) noexcept;
  REACT_METHOD(CancelIncomingCallNotification, L"cancelIncomingCallNotification")
  void CancelIncomingCallNotification(React::JSValueObject &&arguments, React::ReactPromise<void> &&promise) noexcept;
  REACT_METHOD(ShowIncomingMessageNotification, L"showIncomingMessageNotification")
  void ShowIncomingMessageNotification(React::JSValueObject &&arguments, React::ReactPromise<bool> &&promise) noexcept;
  REACT_METHOD(ShowIncomingCallNotification, L"showIncomingCallNotification")
  void ShowIncomingCallNotification(React::JSValueObject &&arguments, React::ReactPromise<bool> &&promise) noexcept;
  REACT_METHOD(StartVoiceRecording, L"startVoiceRecording")
  void StartVoiceRecording(React::JSValueObject &&arguments, React::ReactPromise<void> &&promise) noexcept;
  REACT_METHOD(StopVoiceRecording, L"stopVoiceRecording")
  void StopVoiceRecording(React::JSValueObject &&arguments, React::ReactPromise<React::JSValue> &&promise) noexcept;
  REACT_METHOD(PlayVoiceMessage, L"playVoiceMessage")
  void PlayVoiceMessage(React::JSValueObject &&arguments, React::ReactPromise<void> &&promise) noexcept;
  REACT_METHOD(StartLiveVoiceAudio, L"startLiveVoiceAudio")
  void StartLiveVoiceAudio(React::JSValueObject &&arguments, React::ReactPromise<void> &&promise) noexcept;
  REACT_METHOD(StopLiveVoiceAudio, L"stopLiveVoiceAudio")
  void StopLiveVoiceAudio(React::JSValueObject &&arguments, React::ReactPromise<void> &&promise) noexcept;
  REACT_METHOD(PlayLiveVoiceAudio, L"playLiveVoiceAudio")
  void PlayLiveVoiceAudio(React::JSValueObject &&arguments, React::ReactPromise<void> &&promise) noexcept;
  REACT_METHOD(AddListener, L"addListener")
  void AddListener(std::string eventName) noexcept;
  REACT_METHOD(RemoveListeners, L"removeListeners")
  void RemoveListeners(double count) noexcept;

private:
  void Emit(React::JSValueObject &&event) noexcept;
  void EmitLog(std::string const &message) noexcept;
  void QueuePacket(React::JSValueObject const &arguments, React::ReactPromise<void> const &promise,
                   bool optimizeConnectionAfterWrite) noexcept;
  winrt::fire_and_forget ConnectAsync(uint64_t address, React::ReactPromise<void> promise) noexcept;
  winrt::fire_and_forget WriteFrameAsync(std::vector<uint8_t> frame, React::ReactPromise<void> promise,
                                         bool optimizeConnectionAfterWrite) noexcept;
  void HandleValue(Windows::Devices::Bluetooth::GenericAttributeProfile::GattCharacteristic const &sender,
                   Windows::Devices::Bluetooth::GenericAttributeProfile::GattValueChangedEventArgs const &args) noexcept;
  void AppendFrame(std::vector<uint8_t> const &bytes, std::vector<uint8_t> &accumulator, std::string const &route) noexcept;
  void Close(bool emitDisconnected) noexcept;

  React::ReactContext m_context;
  Windows::Devices::Bluetooth::Advertisement::BluetoothLEAdvertisementWatcher m_watcher{nullptr};
  Windows::Devices::Bluetooth::BluetoothLEDevice m_device{nullptr};
  Windows::Devices::Bluetooth::BluetoothLEPreferredConnectionParametersRequest m_preferredConnectionRequest{nullptr};
  winrt::event_token m_connectionStatusToken{};
  bool m_hasConnectionStatusHandler{false};
  winrt::event_token m_connectionParametersToken{};
  bool m_hasConnectionParametersHandler{false};
  winrt::event_token m_connectionPhyToken{};
  bool m_hasConnectionPhyHandler{false};
  std::atomic_uint64_t m_connectionGeneration{0};
  Windows::Devices::Bluetooth::GenericAttributeProfile::GattDeviceService m_service{nullptr};
  Windows::Devices::Bluetooth::GenericAttributeProfile::GattSession m_session{nullptr};
  winrt::event_token m_sessionStatusToken{};
  bool m_hasSessionStatusHandler{false};
  Windows::Devices::Bluetooth::GenericAttributeProfile::GattCharacteristic m_rx{nullptr};
  Windows::Devices::Bluetooth::GenericAttributeProfile::GattCharacteristic m_ota{nullptr};
  std::vector<Windows::Devices::Bluetooth::GenericAttributeProfile::GattCharacteristic> m_notifications;
  std::vector<uint8_t> m_receive;
  std::vector<uint8_t> m_forwardReceive;
  std::mutex m_frameMutex;
};

} // namespace winrt::EdgezReactNativeSdk
