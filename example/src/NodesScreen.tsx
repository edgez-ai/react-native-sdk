import React, {useMemo, useState} from 'react';
import {ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View} from 'react-native';
import {
  edgezNodeDisplayName, edgezNodeId,
  isEdgezPublicChannel, type EdgezMeshNode, type EdgezMeshState,
} from '@edgez/react-native-sdk';
import {
  frequencyForChannel, halowFrequenciesKhz, halowFrequencyLabel,
  lastSeenAge, nodeMarkerColor, sensorSummary,
} from './presentation';
import {Button, Card, Row, ui} from './ui';

interface Props {
  state: EdgezMeshState;
  meshCountry: string;
  meshBandwidthMhz: number;
  meshFrequencyKhz: number;
  onMeshFrequencyChanged: (frequencyKhz: number) => void | Promise<void>;
  onRemoveNode: (nodeNum: bigint) => void;
  onTogglePublicChannel: (port: bigint, enabled: boolean) => void | Promise<void>;
}

export function NodesScreen(props: Props) {
  const [showRoutes, setShowRoutes] = useState(false);
  const [selectedNode, setSelectedNode] = useState<bigint>();
  const [expandedChannels, setExpandedChannels] = useState<ReadonlySet<number>>(new Set());
  const nodes = [...props.state.nodes.values()];
  const publicChannels = nodes.filter(node => isEdgezPublicChannel(node.nodeNum));
  const discovered = nodes.filter(node => !isEdgezPublicChannel(node.nodeNum));
  const selected = selectedNode === undefined ? undefined : props.state.nodes.get(selectedNode);
  const groups = useMemo(() => {
    const result = new Map<number, EdgezMeshNode[]>();
    for (const node of discovered) {
      const channel = node.channelNumber ?? 0;
      result.set(channel, [...result.get(channel) ?? [], node]);
    }
    for (const values of result.values()) values.sort((a, b) => edgezNodeDisplayName(a).localeCompare(edgezNodeDisplayName(b)));
    return [...result.entries()].sort(([a], [b]) => a === 0 ? 1 : b === 0 ? -1 : a - b);
  }, [discovered]);
  const run = (action: () => void | Promise<void>) => {
    try { void Promise.resolve(action()).catch(error => console.warn('Node action failed', error)); }
    catch (error) { console.warn('Node action failed', error); }
  };

  if (selected) return <NodeDetail node={selected} state={props.state} onBack={() => setSelectedNode(undefined)} />;
  if (showRoutes) return <RoutesScreen state={props.state} onBack={() => setShowRoutes(false)} />;

  const frequencies = halowFrequenciesKhz(props.meshCountry, props.meshBandwidthMhz);
  return <ScrollView style={ui.screen} contentContainerStyle={ui.content}>
    <View style={styles.titleRow}><Text style={ui.heading}>Nodes</Text><Button label="Routes" secondary onPress={() => setShowRoutes(true)} /></View>
    <Text style={ui.muted}>Interface: {props.state.connection.toUpperCase()} · {discovered.length} discovered</Text>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.frequencyRow}>
      {frequencies.map(value => <TouchableOpacity key={value} disabled={!props.state.bleReady} style={[styles.frequency, value === props.meshFrequencyKhz && styles.frequencyActive, !props.state.bleReady && styles.disabled]} onPress={() => run(() => props.onMeshFrequencyChanged(value))}>
        <Text style={styles.frequencyText}>{halowFrequencyLabel(props.meshCountry, value)}</Text>
      </TouchableOpacity>)}
    </ScrollView>

    <Card title="Public channels" action={<Text style={ui.muted}>{publicChannels.length} channels</Text>}>
      {publicChannels.map(node => <TouchableOpacity key={node.nodeNum.toString()} style={styles.publicRow} onPress={() => setSelectedNode(node.nodeNum)}>
        <View style={styles.nodeMain}><View style={[styles.marker, {backgroundColor: nodeMarkerColor(node)}]} /><View><Text style={styles.nodeName}>{edgezNodeDisplayName(node)}</Text><Text style={ui.muted}>Talkgroup port {node.nodeNum.toString()}</Text></View></View>
        <Switch value={node.enabled !== false} onValueChange={enabled => run(() => props.onTogglePublicChannel(node.nodeNum, enabled))} trackColor={{true: '#0F9F91'}} />
      </TouchableOpacity>)}
    </Card>

    {!discovered.length ? <Card title="Waiting for nodes"><Text style={ui.muted}>No beacon or discovery packets received yet. Connect BLE and save mesh settings to join the mesh.</Text></Card> : null}
    {groups.map(([channel, channelNodes]) => {
      const expanded = expandedChannels.has(channel);
      const frequency = frequencyForChannel(props.meshCountry, channel);
      return <Card key={channel} title={channel ? `Channel ${channel}` : 'Unknown channel'} action={<TouchableOpacity onPress={() => setExpandedChannels(current => {const next = new Set(current); expanded ? next.delete(channel) : next.add(channel); return next;})}><Text style={styles.link}>{expanded ? 'Hide' : 'Show'}</Text></TouchableOpacity>}>
        <Text style={ui.muted}>{frequency ? `${(frequency / 1000).toFixed(3)} MHz · ` : ''}{channelNodes.length} {channelNodes.length === 1 ? 'node' : 'nodes'}</Text>
        {expanded ? channelNodes.map(node => {
          const samples = props.state.sensorSamples.get(node.nodeNum) ?? [];
          const latest = samples[samples.length - 1]?.data;
          return <NodeCard key={node.nodeNum.toString()} node={node} sensor={sensorSummary(latest)} onOpen={() => setSelectedNode(node.nodeNum)} onRemove={() => props.onRemoveNode(node.nodeNum)} />;
        }) : null}
      </Card>;
    })}
  </ScrollView>;
}

function NodeCard({node, sensor, onOpen, onRemove}: {node: EdgezMeshNode; sensor?: string; onOpen: () => void; onRemove: () => void}) {
  return <TouchableOpacity style={styles.nodeCard} onPress={onOpen}>
    <View style={styles.nodeTop}><View style={styles.nodeMain}><View style={[styles.marker, {backgroundColor: nodeMarkerColor(node)}]} /><View style={styles.nodeText}><Text style={styles.nodeName}>{edgezNodeDisplayName(node)}</Text><Text style={ui.muted}>Node {edgezNodeId(node.nodeNum)}</Text><Text style={ui.muted}>Type {node.deviceType || 'Unspecified'}</Text></View></View><Text style={node.sleeping ? styles.sleeping : styles.seen}>{node.sleeping ? 'Sleeping' : lastSeenAge(node.lastSeenMs)}</Text></View>
    {node.geoFenceName ? <Text style={ui.muted}>Geofence {node.geoFenceName}</Text> : null}
    {sensor ? <Text style={ui.muted}>{sensor}</Text> : null}
    <View style={styles.nodeFooter}><Text style={ui.muted}>{node.route}</Text><TouchableOpacity onPress={onRemove}><Text style={styles.remove}>Remove</Text></TouchableOpacity></View>
  </TouchableOpacity>;
}

function NodeDetail({node, state, onBack}: {node: EdgezMeshNode; state: EdgezMeshState; onBack: () => void}) {
  const samples = state.sensorSamples.get(node.nodeNum) ?? [];
  const latest = samples[samples.length - 1];
  return <ScrollView style={ui.screen} contentContainerStyle={ui.content}>
    <View style={styles.titleRow}><Button label="Back" secondary onPress={onBack} /><Text style={ui.heading}>{edgezNodeDisplayName(node)}</Text></View>
    <Card title="Device"><Row label="Node" value={edgezNodeId(node.nodeNum)} /><Row label="Type" value={node.deviceType || 'Unspecified'} /><Row label="Marker" value={node.marker} /><Row label="Route" value={node.route} /><Row label="Last seen" value={lastSeenAge(node.lastSeenMs)} /><Row label="State" value={node.sleeping ? 'Sleeping' : 'Awake'} /></Card>
    <Card title="Location"><Text style={ui.muted}>{node.latitude !== undefined && node.longitude !== undefined ? `${node.latitude.toFixed(6)}, ${node.longitude.toFixed(6)}` : 'No location received'}</Text></Card>
    <Card title="Geo fence"><Text style={ui.muted}>{node.geoFenceName ? `${node.geoFenceName} · index ${node.geoIndex}` : 'None'}</Text></Card>
    <Card title="Sensor"><Text style={ui.muted}>{sensorSummary(latest?.data) ?? 'No sensor data received yet'}</Text>{latest ? <Text style={ui.muted}>Updated {lastSeenAge(latest.timestampMs)}</Text> : null}</Card>
  </ScrollView>;
}

function RoutesScreen({state, onBack}: {state: EdgezMeshState; onBack: () => void}) {
  return <ScrollView style={ui.screen} contentContainerStyle={ui.content}>
    <View style={styles.titleRow}><Button label="Back" secondary onPress={onBack} /><Text style={ui.heading}>Mesh routes</Text></View>
    {!state.topologyLinks.length ? <Card title="No topology"><Text style={ui.muted}>No route reports received yet.</Text></Card> : state.topologyLinks.map(link => {
      const from = state.nodes.get(link.reporterNodeNum);
      const to = state.nodes.get(link.peerNodeNum);
      return <Card key={`${link.reporterNodeNum}:${link.peerNodeNum}`} title={`${from ? edgezNodeDisplayName(from) : edgezNodeId(link.reporterNodeNum)} → ${to ? edgezNodeDisplayName(to) : edgezNodeId(link.peerNodeNum)}`}><Row label="RSSI" value={String(link.encodedRssi)} /><Row label="Updated" value={lastSeenAge(link.lastSeenMs)} /></Card>;
    })}
  </ScrollView>;
}

const styles = StyleSheet.create({
  titleRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12}, frequencyRow: {gap: 7}, frequency: {borderWidth: 1, borderColor: '#354A64', borderRadius: 99, padding: 9}, frequencyActive: {backgroundColor: '#0F766E', borderColor: '#2DD4BF'}, frequencyText: {color: '#DCE7F5', fontWeight: '600'}, disabled: {opacity: 0.4},
  publicRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 7}, nodeCard: {backgroundColor: '#17263A', borderRadius: 12, padding: 13, gap: 7, borderWidth: 1, borderColor: '#2A3C54'}, nodeTop: {flexDirection: 'row', justifyContent: 'space-between', gap: 10}, nodeMain: {flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1}, nodeText: {flex: 1}, marker: {width: 12, height: 12, borderRadius: 6}, nodeName: {color: '#FFF', fontSize: 16, fontWeight: '700'}, seen: {color: '#8CA0BA', fontSize: 12}, sleeping: {color: '#FACC15', fontWeight: '700'}, nodeFooter: {flexDirection: 'row', justifyContent: 'space-between'}, link: {color: '#2DD4BF', fontWeight: '700'}, remove: {color: '#F87171', fontWeight: '700'},
});
