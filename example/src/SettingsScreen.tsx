import React, {useEffect, useState} from 'react';
import {ScrollView, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {
  edgezBleDeviceLabel, isMeshUsable, type EdgezDeviceSettings,
  type EdgezMeshConfig, type EdgezMeshSession, type EdgezMeshState,
} from '@edgez/react-native-sdk';
import {halowBandwidthOptions, halowFrequenciesKhz, halowFrequencyLabel, markerOptions} from './presentation';
import {Button, Card, Choices, Field, Row, ToggleRow, ui} from './ui';

type SettingsTab = 'User' | 'Mesh Network' | 'Others';
type DeviceDraft = {
  deviceModeEnabled: boolean; userName: string; marker: string; shareLocation: boolean;
  deviceGpsEnabled: boolean; latitude: string; longitude: string; geoFenceName: string;
  geoIndex: string; meshId: string; passphrase: string; maxHop: string;
  beaconIntervalSeconds: string; meshFrequencyKhz: number; meshBandwidthMhz: number;
  sensorsEnabled: boolean; uartI2cSensorType: string; rs485SensorType: string; deviceType: string;
  upstreamEnabled: boolean; upstreamWifiSsid: string; upstreamWifiPassphrase: string;
  beaconMulticast: string; sleepModeEnabled: boolean;
};

const multicastOptions = ['', '224.0.0.1', '224.0.0.251', '239.255.255.250', '239.255.0.1', '239.192.0.1'];

function formatIpv4(value?: bigint): string {
  if (!value) return '';
  return [24n, 16n, 8n, 0n].map(shift => Number((value >> shift) & 0xffn)).join('.');
}

function parseIpv4(value: string): bigint {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return 0n;
  return parts.reduce((result, part) => (result << 8n) | BigInt(part), 0n);
}

interface Props {
  state: EdgezMeshState;
  session: EdgezMeshSession;
  config?: EdgezMeshConfig;
  onConfigChanged: (config: EdgezMeshConfig) => void;
  onSaveConfig: () => Promise<void>;
  onRegenerateIdentity: () => Promise<void>;
}

const deviceDraft = (settings?: EdgezDeviceSettings): DeviceDraft => ({
  deviceModeEnabled: settings?.deviceModeEnabled ?? false,
  userName: settings?.userName ?? 'EdgeZ Device', marker: settings?.marker ?? 'green',
  shareLocation: settings?.shareLocation ?? false, deviceGpsEnabled: settings?.deviceGpsEnabled ?? false,
  latitude: settings?.latitude?.toString() ?? '', longitude: settings?.longitude?.toString() ?? '',
  geoFenceName: settings?.geoFenceName ?? '', geoIndex: String(settings?.geoIndex ?? 0),
  meshId: settings?.meshId ?? 'edgez', passphrase: settings?.passphrase ?? '',
  maxHop: String(settings?.maxHop ?? 4), beaconIntervalSeconds: String(settings?.beaconIntervalSeconds ?? 10),
  meshFrequencyKhz: settings?.meshFrequencyKhz || 902500, meshBandwidthMhz: settings?.meshBandwidthMhz || 1,
  sensorsEnabled: !!(settings?.uartI2cSensorType || settings?.rs485SensorType),
  uartI2cSensorType: settings?.uartI2cSensorType ?? '', rs485SensorType: settings?.rs485SensorType ?? '',
  deviceType: settings?.deviceType ?? 'relay',
  upstreamEnabled: !!(settings?.upstreamWifiSsid || settings?.beaconUnicast),
  upstreamWifiSsid: settings?.upstreamWifiSsid ?? '', upstreamWifiPassphrase: settings?.upstreamWifiPassphrase ?? '',
  beaconMulticast: formatIpv4(settings?.beaconUnicast), sleepModeEnabled: settings?.sleepModeEnabled ?? false,
});

export function SettingsScreen({state, session, config, onConfigChanged, onSaveConfig, onRegenerateIdentity}: Props) {
  const [tab, setTab] = useState<SettingsTab>('User');
  const [draft, setDraft] = useState<DeviceDraft>(() => deviceDraft(state.deviceSettings));
  const [notice, setNotice] = useState('');
  useEffect(() => { if (state.deviceSettings) setDraft(deviceDraft(state.deviceSettings)); }, [state.deviceSettings]);
  const patchDraft = (change: Partial<DeviceDraft>) => setDraft(current => ({...current, ...change}));
  const run = async (label: string, action: () => Promise<unknown>) => {
    try { setNotice(`${label}…`); await action(); setNotice(`${label} complete`); }
    catch (error) { setNotice(`${label} failed: ${String(error)}`); }
  };

  if (!config) return <ScrollView style={ui.screen} contentContainerStyle={ui.content}><Text style={ui.heading}>Settings</Text><Card title="Loading"><Text style={ui.muted}>Loading user identity…</Text></Card></ScrollView>;
  const beacon = config.beacon ?? {};
  const update = (change: Partial<EdgezMeshConfig>) => onConfigChanged({...config, ...change});
  const updateBeacon = (change: Partial<NonNullable<EdgezMeshConfig['beacon']>>) => update({beacon: {...beacon, ...change}});
  const frequencies = halowFrequenciesKhz(config.countryCode ?? 'US', config.meshBandwidthMhz ?? 1);

  const saveDevice = async () => {
    const number = (value: string, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    await session.sendDeviceSettings({
      ...draft, latitude: draft.latitude ? number(draft.latitude, 0) : undefined,
      longitude: draft.longitude ? number(draft.longitude, 0) : undefined,
      geoIndex: number(draft.geoIndex, 0), maxHop: number(draft.maxHop, 4),
      beaconIntervalSeconds: number(draft.beaconIntervalSeconds, 10),
      uartI2cSensorType: draft.sensorsEnabled ? draft.uartI2cSensorType.trim() : '',
      rs485SensorType: draft.sensorsEnabled ? draft.rs485SensorType.trim() : '',
      upstreamWifiSsid: draft.upstreamEnabled ? draft.upstreamWifiSsid.trim() : '',
      upstreamWifiPassphrase: draft.upstreamEnabled ? draft.upstreamWifiPassphrase : '',
      beaconUnicast: draft.upstreamEnabled ? parseIpv4(draft.beaconMulticast) : 0n,
    }, config.identity);
  };

  return <ScrollView style={ui.screen} contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
    <Text style={ui.heading}>Settings</Text>
    <Text style={ui.muted}>{notice || state.statusLine}</Text>
    <Card title="Device connection">
      <Row label="Interface" value={state.connection.toUpperCase()} /><Row label="Control channel" value={state.bleReady ? 'Ready' : state.bleConnecting ? 'Connecting' : 'Waiting'} />
      <Row label="Firmware" value={state.status?.firmwareVersion || 'Unknown'} /><Row label="License" value={state.status?.licenseStatus || 'Waiting for status'} />
      <View style={ui.actions}><Button label={state.connection === 'none' ? 'Scan BLE' : 'Disconnect'} onPress={() => state.connection === 'none' ? session.startBleScan() : session.disconnect()} /><Button label="Request settings" secondary disabled={!state.bleReady} onPress={() => run('Device settings request', () => session.requestDeviceSettings())} /></View>
      {state.connection === 'none' ? [...state.bleDevices.values()].map(device => <TouchableOpacity key={device.id} style={styles.device} onPress={() => void session.connectBle(device.id)}><Text style={styles.value}>{edgezBleDeviceLabel(device)}</Text><Text style={styles.link}>Connect</Text></TouchableOpacity>) : null}
    </Card>

    <View style={ui.sectionTabs}>{(['User', 'Mesh Network', 'Others'] as SettingsTab[]).map(value => <TouchableOpacity key={value} style={[styles.tab, tab === value && styles.tabActive]} onPress={() => setTab(value)}><Text style={styles.tabText}>{value}</Text></TouchableOpacity>)}</View>

    {tab === 'User' ? <>
      <Card title="User">
        <Field label="User name" value={config.identity.name} onChangeText={name => update({identity: {...config.identity, name}})} />
        <Choices label="Marker" values={markerOptions} value={beacon.marker ?? 'blue'} onChange={marker => updateBeacon({marker})} />
        <Row label="Identity" value={config.identity.userUuid} />
        <Button label="Regenerate key pair" secondary onPress={() => run('Identity regeneration', onRegenerateIdentity)} />
      </Card>
      <Card title="Location">
        <ToggleRow label="Share location" detail="Include location in HaLow beacon" value={beacon.shareLocation ?? false} onValueChange={shareLocation => updateBeacon({shareLocation})} />
        {beacon.shareLocation ? <><Row label="Latitude" value={beacon.latitude?.toFixed(6) ?? 'Not available'} /><Row label="Longitude" value={beacon.longitude?.toFixed(6) ?? 'Not available'} /><Button label="Refresh phone location" secondary onPress={() => run('Location refresh', async () => {const location = await session.sdk.getBestKnownLocation(); if (!location) throw new Error('No phone location available'); updateBeacon({...location, shareLocation: true, locationTimestampMs: location.timestampMs});})} /></> : null}
      </Card>
      <Button label="Save user settings" onPress={() => run('Saving settings', onSaveConfig)} />
    </> : null}

    {tab === 'Mesh Network' ? <>
      <Card title="Mesh network">
        <Choices label="Country" values={['US', 'JP', 'EU']} value={config.countryCode ?? 'US'} onChange={countryCode => {const bandwidth = halowBandwidthOptions(countryCode)[0] ?? 1; update({countryCode, meshBandwidthMhz: bandwidth, meshFrequencyKhz: halowFrequenciesKhz(countryCode, bandwidth)[0] ?? 0});}} />
        <Choices label="Bandwidth" values={halowBandwidthOptions(config.countryCode ?? 'US')} value={config.meshBandwidthMhz ?? 1} titleFor={value => `${value} MHz`} onChange={meshBandwidthMhz => update({meshBandwidthMhz, meshFrequencyKhz: halowFrequenciesKhz(config.countryCode ?? 'US', meshBandwidthMhz)[0] ?? 0})} />
        <Choices label="Channel" values={frequencies} value={config.meshFrequencyKhz ?? frequencies[0] ?? 0} titleFor={value => halowFrequencyLabel(config.countryCode ?? 'US', value)} onChange={meshFrequencyKhz => update({meshFrequencyKhz})} />
        <Field label="Mesh ID / SSID" value={config.meshId ?? ''} onChangeText={meshId => update({meshId})} />
        <Field label="Passphrase" value={config.passphrase ?? ''} secureTextEntry onChangeText={passphrase => update({passphrase})} />
        <Field label="Max hop" value={String(config.maxHop ?? 4)} keyboardType="numeric" onChangeText={value => update({maxHop: Math.max(0, Math.min(255, Number.parseInt(value || '0', 10)))})} />
        <Field label="Beacon interval (seconds)" value={String(beacon.intervalSeconds ?? 10)} keyboardType="numeric" onChangeText={value => updateBeacon({intervalSeconds: Math.max(5, Math.min(3600, Number.parseInt(value || '5', 10)))})} />
        <Button label="Save settings" disabled={!state.bleReady} onPress={() => run('Mesh initialization', onSaveConfig)} />
        {!isMeshUsable(state.status) ? <Text style={ui.muted}>Connect BLE and wait for a usable mesh status before changing channels.</Text> : null}
      </Card>
    </> : null}

    {tab === 'Others' ? <>
      <Card title="Device settings">
        <ToggleRow label="Device mode" value={draft.deviceModeEnabled} onValueChange={deviceModeEnabled => patchDraft({deviceModeEnabled})} />
        <Field label="Device user name" value={draft.userName} onChangeText={userName => patchDraft({userName})} />
        <Choices label="Marker" values={markerOptions} value={draft.marker} onChange={marker => patchDraft({marker})} />
        <Choices label="Device type" values={['user', 'gateway', 'beacon', 'sensor', 'relay']} value={draft.deviceType} onChange={deviceType => patchDraft({deviceType})} />
        <ToggleRow label="Share location" value={draft.shareLocation} onValueChange={shareLocation => patchDraft({shareLocation})} />
        {draft.shareLocation ? <ToggleRow label="Use device GPS (L76K)" value={draft.deviceGpsEnabled} onValueChange={deviceGpsEnabled => patchDraft({deviceGpsEnabled})} /> : null}
        {draft.shareLocation && !draft.deviceGpsEnabled ? <View style={styles.columns}><View style={styles.column}><Field label="Latitude" value={draft.latitude} keyboardType="decimal-pad" onChangeText={latitude => patchDraft({latitude})} /></View><View style={styles.column}><Field label="Longitude" value={draft.longitude} keyboardType="decimal-pad" onChangeText={longitude => patchDraft({longitude})} /></View></View> : null}
        <ToggleRow label="Enable geofence" detail="Include a geofence in device beacons" value={!!draft.geoFenceName.trim()} onValueChange={enabled => patchDraft({geoFenceName: enabled ? 'Geo fence' : ''})} />
        {draft.geoFenceName ? <><Field label="Geo fence" value={draft.geoFenceName} onChangeText={geoFenceName => patchDraft({geoFenceName})} /><Field label="Geo index" value={draft.geoIndex} keyboardType="numeric" onChangeText={geoIndex => patchDraft({geoIndex})} /></> : null}
      </Card>
      <Card title="Device network">
        <Choices label="Bandwidth" values={[1, 2, 4, 8]} value={draft.meshBandwidthMhz} titleFor={value => `${value} MHz`} onChange={meshBandwidthMhz => patchDraft({meshBandwidthMhz})} />
        <Field label="Frequency (kHz)" value={String(draft.meshFrequencyKhz)} keyboardType="numeric" onChangeText={value => patchDraft({meshFrequencyKhz: Number.parseInt(value || '0', 10)})} />
        <Field label="Mesh ID / SSID" value={draft.meshId} onChangeText={meshId => patchDraft({meshId})} />
        <Field label="Passphrase" value={draft.passphrase} secureTextEntry onChangeText={passphrase => patchDraft({passphrase})} />
        <Field label="Max hop" value={draft.maxHop} keyboardType="numeric" onChangeText={maxHop => patchDraft({maxHop})} />
        <Field label="Beacon interval (seconds)" value={draft.beaconIntervalSeconds} keyboardType="numeric" onChangeText={beaconIntervalSeconds => patchDraft({beaconIntervalSeconds})} />
      </Card>
      <Card title="Device sensors">
        <ToggleRow label="Enable sensors" detail="Configure device sensor connectors" value={draft.sensorsEnabled} onValueChange={sensorsEnabled => patchDraft({sensorsEnabled})} />
        {draft.sensorsEnabled ? <><Field label="UART/I2C driver" value={draft.uartI2cSensorType} onChangeText={uartI2cSensorType => patchDraft({uartI2cSensorType})} /><Field label="RS485 driver" value={draft.rs485SensorType} onChangeText={rs485SensorType => patchDraft({rs485SensorType})} /></> : null}
      </Card>
      <Card title="Upstream network">
        <ToggleRow label="Enable upstream network" detail="Forward through Wi-Fi and send beacons to a multicast address" value={draft.upstreamEnabled} onValueChange={upstreamEnabled => patchDraft({upstreamEnabled})} />
        {draft.upstreamEnabled ? <><Field label="Wi-Fi SSID" value={draft.upstreamWifiSsid} onChangeText={upstreamWifiSsid => patchDraft({upstreamWifiSsid})} /><Field label="Wi-Fi passphrase" value={draft.upstreamWifiPassphrase} secureTextEntry onChangeText={upstreamWifiPassphrase => patchDraft({upstreamWifiPassphrase})} /><Choices label="Beacon multicast" values={multicastOptions} value={draft.beaconMulticast} titleFor={value => value || 'Not set'} onChange={beaconMulticast => patchDraft({beaconMulticast})} /></> : null}
      </Card>
      <Card title="Sleep mode"><ToggleRow label="Enable sleep mode" detail="Allow the device to enter low-power sleep" value={draft.sleepModeEnabled} onValueChange={sleepModeEnabled => patchDraft({sleepModeEnabled})} /></Card>
      <Button label="Save to device" disabled={!state.bleReady} onPress={() => run('Device settings update', saveDevice)} />
      <Card title="App permissions & firmware"><Row label="BLE OTA" value={state.otaReady ? 'Ready' : 'Unavailable'} /><View style={ui.actions}><Button label="Enable notifications" secondary onPress={() => run('Notification permission', () => session.sdk.requestNotificationPermission())} /><Button label="Check OTA capability" secondary onPress={() => run('OTA capability check', () => session.sdk.isOtaReady())} /></View></Card>
    </> : null}
  </ScrollView>;
}

const styles = StyleSheet.create({
  tab: {flex: 1, borderWidth: 1, borderColor: '#354A64', paddingVertical: 10, borderRadius: 10, alignItems: 'center'}, tabActive: {backgroundColor: '#0F766E', borderColor: '#2DD4BF'}, tabText: {color: '#FFF', fontWeight: '700', fontSize: 12},
  device: {flexDirection: 'row', justifyContent: 'space-between', gap: 8, backgroundColor: '#17263A', borderRadius: 10, padding: 12}, value: {color: '#FFF', flex: 1}, link: {color: '#2DD4BF', fontWeight: '700'}, columns: {flexDirection: 'row', gap: 8}, column: {flex: 1},
});
