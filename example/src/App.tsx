import React, {useEffect, useMemo, useState} from 'react';
import {ScrollView, StatusBar, StyleSheet, Text, TextInput, TouchableOpacity, View} from 'react-native';
import {
  EdgezBleConfigurationStore, EdgezIdentityStore, EdgezMeshSdk, EdgezMeshSession,
  edgezNodeDisplayName, edgezNodeOpensConversation, edgezPublicChannelPorts,
  isEdgezPublicChannel, type EdgezBleDevice, type EdgezMeshConfig, type EdgezMeshNode, useEdgezMesh,
} from '@edgez/react-native-sdk';
import {NodesScreen} from './NodesScreen';
import {SettingsScreen} from './SettingsScreen';
import {Button, Card, ui} from './ui';
import {SafeAreaFrame} from './SafeAreaFrame';

type Tab = 'Nodes' | 'Messages' | 'Settings';

export default function App() {
  const sdk = useMemo(() => new EdgezMeshSdk(), []);
  const identityStore = useMemo(() => new EdgezIdentityStore(), []);
  const bleStore = useMemo(() => new EdgezBleConfigurationStore(), []);
  const session = useMemo(() => new EdgezMeshSession({sdk, onIncomingMessage: (message, sender) => {
    void sdk.showIncomingMessageNotification(message, sender).catch(error => console.warn('Notification failed', error));
  }}), [sdk]);
  const state = useEdgezMesh(session);
  const [tab, setTab] = useState<Tab>('Nodes');
  const [config, setConfig] = useState<EdgezMeshConfig>();
  const [selectedBleDevice, setSelectedBleDevice] = useState<EdgezBleDevice>();
  const [bleAutoConnect, setBleAutoConnect] = useState(false);
  const [selected, setSelected] = useState<bigint>();
  const [message, setMessage] = useState('Hello from React Native!');
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    void Promise.all([identityStore.getOrCreate(), bleStore.load()]).then(async ([identity, saved]) => {
      const initialConfig: EdgezMeshConfig = {
        identity, countryCode: 'US', meshId: 'edgez', passphrase: 'edgez123',
        maxHop: 4, meshBandwidthMhz: 1, meshFrequencyKhz: 902500,
        enabledPublicChannels: new Set(edgezPublicChannelPorts),
        beacon: {intervalSeconds: 10, marker: 'blue', shareLocation: false},
      };
      setConfig(initialConfig);
      if (saved.deviceId) setSelectedBleDevice({id: saved.deviceId, name: saved.deviceName, rssi: 0, lastSeenMs: 0});
      setBleAutoConnect(saved.autoConnect);
      await session.initializeMesh(initialConfig);
      if (saved.autoConnect && saved.deviceId) {
        await session.connectBle(saved.deviceId);
      }
    }).catch(error => console.warn('App initialization failed', error));
    return () => session.dispose();
  }, [bleStore, identityStore, session]);

  const saveConfig = async () => {
    if (!config) return;
    await identityStore.save(config.identity);
    await session.initializeMesh(config);
  };
  const regenerateIdentity = async () => {
    const identity = await identityStore.regenerateKeyPair();
    setConfig(current => current ? {...current, identity} : current);
  };
  const changeFrequency = async (meshFrequencyKhz: number) => {
    if (!config) return;
    const next = {...config, meshFrequencyKhz};
    setConfig(next);
    await session.initializeMesh(next);
  };
  const togglePublicChannel = async (port: bigint, enabled: boolean) => {
    setConfig(current => {
      if (!current) return current;
      const channels = new Set(current.enabledPublicChannels ?? edgezPublicChannelPorts);
      enabled ? channels.add(port) : channels.delete(port);
      return {...current, enabledPublicChannels: channels};
    });
    await session.setPublicChannelEnabled(port, enabled);
  };

  const selectBleDevice = async (device: EdgezBleDevice) => {
    setSelectedBleDevice(device);
    await bleStore.saveSelectedDevice(device);
  };
  const changeBleAutoConnect = async (enabled: boolean) => {
    setBleAutoConnect(enabled);
    await bleStore.setAutoConnect(enabled);
  };
  const connectBleDevice = async (deviceId: string) => {
    await saveConfig();
    await sdk.requestNotificationPermission();
    await session.connectBle(deviceId);
  };

  const content = tab === 'Nodes' ? <NodesScreen
    state={state} meshCountry={config?.countryCode ?? 'US'}
    meshBandwidthMhz={config?.meshBandwidthMhz ?? 1}
    meshFrequencyKhz={config?.meshFrequencyKhz ?? 902500}
    onMeshFrequencyChanged={changeFrequency} onRemoveNode={node => session.removeNode(node)}
    onTogglePublicChannel={togglePublicChannel}
  /> : tab === 'Settings' ? <SettingsScreen state={state} session={session} config={config} selectedBleDevice={state.bleDevices.get(selectedBleDevice?.id ?? '') ?? selectedBleDevice} bleAutoConnect={bleAutoConnect} onSelectBleDevice={selectBleDevice} onConnectBleDevice={connectBleDevice} onBleAutoConnectChanged={changeBleAutoConnect} onConfigChanged={setConfig} onSaveConfig={saveConfig} onRegenerateIdentity={regenerateIdentity} />
    : <MessagesScreen state={state} session={session} selected={selected} onSelected={setSelected} message={message} onMessage={setMessage} recording={recording} onRecording={setRecording} />;

  return <SafeAreaFrame style={styles.safe}>
    <StatusBar barStyle="light-content" />
    <View style={styles.header}><Text style={styles.title}>EdgeZ Mesh</Text><Text style={styles.status}>{state.statusLine}</Text></View>
    <View style={styles.content}>{content}</View>
    <View style={styles.tabs}>{(['Nodes', 'Messages', 'Settings'] as Tab[]).map(item => <TouchableOpacity key={item} style={[styles.tab, tab === item && styles.tabActive]} onPress={() => setTab(item)}><Text style={[styles.tabText, tab === item && styles.tabTextActive]}>{item}</Text></TouchableOpacity>)}</View>
  </SafeAreaFrame>;
}

function MessagesScreen({state, session, selected, onSelected, message, onMessage, recording, onRecording}: {state: ReturnType<typeof useEdgezMesh>; session: EdgezMeshSession; selected?: bigint; onSelected: (node?: bigint) => void; message: string; onMessage: (value: string) => void; recording: boolean; onRecording: (value: boolean) => void}) {
  const [notice, setNotice] = useState('');
  const nodes = [...state.nodes.values()].filter(node => !isEdgezPublicChannel(node.nodeNum) && edgezNodeOpensConversation(node));
  const selectedNode = selected === undefined ? undefined : state.nodes.get(selected);
  const readyToSend = !!selectedNode && state.bleReady && !!state.status?.macAddress && selectedNode.publicKey.length === 32;
  const run = async (action: () => Promise<void>) => {
    try { setNotice(''); await action(); }
    catch (error) { setNotice(String(error)); }
  };
  return <ScrollView style={ui.screen} contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
    <Text style={ui.heading}>Messages</Text>
    {!selectedNode ? <><Text style={ui.muted}>Choose a discovered user node.</Text>{nodes.map(node => <NodeRow key={node.nodeNum.toString()} node={node} selected={false} onPress={() => onSelected(node.nodeNum)} />)}</> : <>
      <Card title={edgezNodeDisplayName(selectedNode)} action={<TouchableOpacity onPress={() => onSelected(undefined)}><Text style={styles.link}>Change</Text></TouchableOpacity>}>
        {(state.conversations.get(selectedNode.nodeNum) ?? []).map(item => <TouchableOpacity key={`${item.messageUuid}-${item.timestampMs}`} disabled={!item.voiceBytes.length} onPress={() => session.playVoiceMessage(item)} style={[styles.bubble, item.mine ? styles.mine : styles.theirs]}><Text style={styles.bubbleText}>{item.text}{item.voiceBytes.length ? ' · Tap to play' : ''}</Text><Text style={styles.bubbleStatus}>{item.status}</Text></TouchableOpacity>)}
      </Card>
      {!readyToSend ? <Text style={ui.muted}>Wait for BLE mesh status and a peer public key before sending.</Text> : null}
      {notice ? <Text style={styles.error}>{notice}</Text> : null}
      <TextInput style={styles.input} value={message} onChangeText={onMessage} placeholder="Message" placeholderTextColor="#738095" />
      <Button label="Send encrypted message" disabled={!readyToSend || !message.trim()} onPress={() => run(async () => {await session.sendTextMessage(selectedNode.nodeNum, message.trim()); onMessage('');})} />
      <View style={ui.actions}>{recording ? <><Button label="Send voice message" disabled={!readyToSend} onPress={() => run(async () => {await session.finishVoiceMessage(selectedNode.nodeNum); onRecording(false);})} /><Button label="Cancel recording" secondary onPress={() => run(async () => {await session.cancelVoiceMessage(); onRecording(false);})} /></> : <Button label="Record voice message" secondary disabled={!readyToSend} onPress={() => run(async () => {await session.startVoiceMessage(); onRecording(true);})} />}</View>
    </>}
  </ScrollView>;
}

function NodeRow({node, selected, onPress}: {node: EdgezMeshNode; selected: boolean; onPress: () => void}) {
  return <TouchableOpacity style={[styles.listItem, selected && styles.selected]} onPress={onPress}><View style={styles.flex}><Text style={styles.itemTitle}>{edgezNodeDisplayName(node)}</Text><Text style={ui.muted}>{node.deviceType} · {node.route} · {node.nodeNum.toString(16)}</Text></View><Text style={styles.link}>Open</Text></TouchableOpacity>;
}

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: '#07101E'}, content: {flex: 1}, header: {paddingHorizontal: 18, paddingVertical: 10, backgroundColor: '#07101E'}, title: {color: '#FFF', fontWeight: '800', fontSize: 24}, status: {color: '#8CA0BA', marginTop: 3, fontSize: 12},
  tabs: {flexDirection: 'row', minHeight: 62, paddingHorizontal: 8, paddingVertical: 6, gap: 4, backgroundColor: '#101C2D', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#2A3C54'}, tab: {flex: 1, justifyContent: 'center', alignItems: 'center', borderRadius: 10}, tabActive: {backgroundColor: '#163B3D'}, tabText: {color: '#8CA0BA', fontSize: 11, fontWeight: '700'}, tabTextActive: {color: '#2DD4BF'},
  listItem: {backgroundColor: '#101C2D', borderRadius: 13, padding: 15, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderWidth: 1, borderColor: '#203249', gap: 8}, selected: {borderColor: '#2DD4BF'}, flex: {flex: 1}, itemTitle: {color: '#FFF', fontSize: 16, fontWeight: '700'}, link: {color: '#2DD4BF', fontWeight: '700'}, input: {backgroundColor: '#0A1422', borderColor: '#2A3C54', borderWidth: 1, borderRadius: 10, padding: 12, color: '#FFF'},
  bubble: {padding: 11, borderRadius: 12, maxWidth: '85%'}, mine: {backgroundColor: '#0B746C', alignSelf: 'flex-end'}, theirs: {backgroundColor: '#283A52', alignSelf: 'flex-start'}, bubbleText: {color: '#FFF'}, bubbleStatus: {color: '#B7D9D5', fontSize: 10, marginTop: 3}, error: {color: '#FCA5A5'},
});
