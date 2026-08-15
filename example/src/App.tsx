import React, {useEffect, useMemo, useState} from 'react';
import {SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput, TouchableOpacity, View} from 'react-native';
import {
  EdgezIdentityStore, EdgezMeshSdk, EdgezMeshSession, edgezBleDeviceLabel, edgezNodeDisplayName,
  type EdgezMeshConfig, type EdgezMeshNode, useEdgezMesh,
} from '@edgez/react-native-sdk';

type Tab = 'Connect' | 'Nodes' | 'Messages' | 'Settings';

export default function App() {
  const sdk = useMemo(() => new EdgezMeshSdk(), []);
  const session = useMemo(() => new EdgezMeshSession({sdk, onIncomingMessage: (message, sender) => { void sdk.showIncomingMessageNotification(message, sender); }}), [sdk]);
  const state = useEdgezMesh(session);
  const [tab, setTab] = useState<Tab>('Connect');
  const [config, setConfig] = useState<EdgezMeshConfig>();
  const [selected, setSelected] = useState<bigint>();
  const [message, setMessage] = useState('Hello from React Native!');
  const [recording, setRecording] = useState(false);
  const [meshId, setMeshId] = useState('edgez');
  const [passphrase, setPassphrase] = useState('');

  useEffect(() => {
    new EdgezIdentityStore().getOrCreate().then(identity => setConfig({identity, countryCode: 'US', meshId, passphrase, maxHop: 4, beacon: {marker: 'blue'}}));
    return () => session.dispose();
  }, [session]);

  const saveMesh = async () => {
    if (!config) return;
    const next = {...config, meshId, passphrase}; setConfig(next); await session.initializeMesh(next);
  };
  const nodes = [...state.nodes.values()];
  const selectedNode = selected === undefined ? undefined : state.nodes.get(selected);

  return <SafeAreaView style={styles.safe}>
    <StatusBar barStyle="light-content" />
    <View style={styles.header}><Text style={styles.title}>EdgeZ Mesh</Text><Text style={styles.status}>{state.statusLine}</Text></View>
    <View style={styles.tabs}>{(['Connect','Nodes','Messages','Settings'] as Tab[]).map(item =>
      <TouchableOpacity key={item} style={[styles.tab, tab === item && styles.tabActive]} onPress={() => setTab(item)}><Text style={styles.tabText}>{item}</Text></TouchableOpacity>)}</View>
    <ScrollView contentContainerStyle={styles.content}>
      {tab === 'Connect' && <>
        <Card title="BLE connection">
          <Row label="Connection" value={state.connection.toUpperCase()} />
          <Row label="Control channel" value={state.bleReady ? 'Ready' : 'Waiting'} />
          <View style={styles.actions}><Button label="Scan" onPress={() => session.startBleScan()} /><Button label="Stop" secondary onPress={() => session.stopBleScan()} /><Button label="Disconnect" secondary onPress={() => session.disconnect()} /></View>
        </Card>
        {[...state.bleDevices.values()].map(device => <TouchableOpacity key={device.id} style={styles.listItem} onPress={() => session.connectBle(device.id)}><View><Text style={styles.itemTitle}>{edgezBleDeviceLabel(device)}</Text><Text style={styles.muted}>RSSI {device.rssi} dBm</Text></View><Text style={styles.link}>Connect</Text></TouchableOpacity>)}
        <Card title="Mesh status">
          <Row label="Mesh" value={state.status?.meshId || '—'} /><Row label="Address" value={state.status?.macAddress.toString(16) || '—'} /><Row label="Firmware" value={state.status?.firmwareVersion || '—'} /><Row label="License" value={state.status?.licenseStatus || '—'} />
        </Card>
      </>}
      {tab === 'Nodes' && <>
        <Text style={styles.sectionTitle}>Discovered nodes</Text>
        {!nodes.length && <Empty text="Connect and initialize the mesh to receive beacons." />}
        {nodes.map(node => <NodeRow key={node.nodeNum.toString()} node={node} selected={node.nodeNum === selected} onPress={() => setSelected(node.nodeNum)} />)}
      </>}
      {tab === 'Messages' && <>
        {!selectedNode ? <><Text style={styles.sectionTitle}>Choose a node</Text>{nodes.map(node => <NodeRow key={node.nodeNum.toString()} node={node} selected={false} onPress={() => setSelected(node.nodeNum)} />)}</> : <>
          <Card title={edgezNodeDisplayName(selectedNode)}>{(state.conversations.get(selectedNode.nodeNum) ?? []).map(item => <TouchableOpacity key={`${item.messageUuid}-${item.timestampMs}`} disabled={!item.voiceBytes.length} onPress={() => session.playVoiceMessage(item)} style={[styles.bubble, item.mine ? styles.mine : styles.theirs]}><Text style={styles.bubbleText}>{item.text}{item.voiceBytes.length ? ' · Tap to play' : ''}</Text><Text style={styles.bubbleStatus}>{item.status}</Text></TouchableOpacity>)}</Card>
          <TextInput style={styles.input} value={message} onChangeText={setMessage} placeholder="Message" placeholderTextColor="#738095" />
          <Button label="Send encrypted message" onPress={async () => {if (message.trim()) {await session.sendTextMessage(selectedNode.nodeNum, message.trim()); setMessage('');}}} />
          <View style={styles.actions}>{recording
            ? <><Button label="Send voice message" onPress={async () => {await session.finishVoiceMessage(selectedNode.nodeNum); setRecording(false);}} /><Button label="Cancel recording" secondary onPress={async () => {await session.cancelVoiceMessage(); setRecording(false);}} /></>
            : <Button label="Record voice message" secondary onPress={async () => {await session.startVoiceMessage(); setRecording(true);}} />}
          </View>
        </>}
      </>}
      {tab === 'Settings' && <>
        <Card title="Mesh configuration">
          <Text style={styles.label}>Mesh ID</Text><TextInput style={styles.input} value={meshId} onChangeText={setMeshId} />
          <Text style={styles.label}>Passphrase</Text><TextInput style={styles.input} value={passphrase} onChangeText={setPassphrase} secureTextEntry />
          <Button label="Save and initialize" onPress={saveMesh} />
        </Card>
        <Card title="Device & firmware"><Button label="Request device settings" secondary onPress={() => session.requestDeviceSettings()} /><View style={styles.spacer}/><Button label="Enable notifications" secondary onPress={() => session.sdk.requestNotificationPermission().then(allowed => console.log('Notifications allowed', allowed))} /><View style={styles.spacer}/><Button label="Check OTA availability" secondary onPress={async () => console.log('OTA ready', await session.sdk.isOtaReady())} /></Card>
      </>}
    </ScrollView>
  </SafeAreaView>;
}

function Card({title, children}: React.PropsWithChildren<{title: string}>) { return <View style={styles.card}><Text style={styles.sectionTitle}>{title}</Text>{children}</View>; }
function Row({label, value}: {label:string; value:string}) { return <View style={styles.row}><Text style={styles.muted}>{label}</Text><Text style={styles.value}>{value}</Text></View>; }
function Button({label, onPress, secondary}: {label:string; onPress:()=>void|Promise<void>; secondary?:boolean}) { return <TouchableOpacity style={[styles.button, secondary && styles.buttonSecondary]} onPress={() => void onPress()}><Text style={styles.buttonText}>{label}</Text></TouchableOpacity>; }
function Empty({text}: {text:string}) { return <View style={styles.empty}><Text style={styles.muted}>{text}</Text></View>; }
function NodeRow({node, selected, onPress}: {node:EdgezMeshNode; selected:boolean; onPress:()=>void}) { return <TouchableOpacity style={[styles.listItem, selected && styles.selected]} onPress={onPress}><View><Text style={styles.itemTitle}>{edgezNodeDisplayName(node)}</Text><Text style={styles.muted}>{node.deviceType} · {node.route} · {node.nodeNum.toString(16)}</Text></View><Text style={styles.link}>Open</Text></TouchableOpacity>; }

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:'#07101e'},header:{padding:20,paddingBottom:12},title:{color:'#fff',fontWeight:'800',fontSize:28},status:{color:'#8ca0ba',marginTop:5},tabs:{flexDirection:'row',paddingHorizontal:12,borderBottomWidth:1,borderBottomColor:'#1b293b'},tab:{flex:1,paddingVertical:13,alignItems:'center'},tabActive:{borderBottomWidth:3,borderBottomColor:'#2dd4bf'},tabText:{color:'#dce7f5',fontSize:12,fontWeight:'700'},content:{padding:16,gap:12},card:{backgroundColor:'#101c2d',borderRadius:16,padding:16,gap:10,borderWidth:1,borderColor:'#203249'},sectionTitle:{color:'#fff',fontSize:18,fontWeight:'700',marginBottom:4},row:{flexDirection:'row',justifyContent:'space-between',paddingVertical:3},muted:{color:'#8ca0ba'},value:{color:'#eef5ff',fontWeight:'600'},actions:{flexDirection:'row',flexWrap:'wrap',gap:8,marginTop:6},button:{backgroundColor:'#0f9f91',paddingHorizontal:15,paddingVertical:12,borderRadius:10,alignItems:'center'},buttonSecondary:{backgroundColor:'#24344a'},buttonText:{color:'#fff',fontWeight:'700'},listItem:{backgroundColor:'#101c2d',borderRadius:13,padding:15,flexDirection:'row',justifyContent:'space-between',alignItems:'center',borderWidth:1,borderColor:'#203249'},selected:{borderColor:'#2dd4bf'},itemTitle:{color:'#fff',fontSize:16,fontWeight:'700'},link:{color:'#2dd4bf',fontWeight:'700'},empty:{padding:28,alignItems:'center'},label:{color:'#b7c6d9',fontWeight:'600',marginTop:5},input:{backgroundColor:'#0a1422',borderColor:'#2a3c54',borderWidth:1,borderRadius:10,padding:12,color:'#fff'},bubble:{padding:11,borderRadius:12,maxWidth:'85%'},mine:{backgroundColor:'#0b746c',alignSelf:'flex-end'},theirs:{backgroundColor:'#283a52',alignSelf:'flex-start'},bubbleText:{color:'#fff'},bubbleStatus:{color:'#b7d9d5',fontSize:10,marginTop:3},spacer:{height:4}
});
