import React, {useMemo, useRef, useState} from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {
  EdgezOrganicMap,
  edgezNodeDisplayName,
  type EdgezMapDownloadUpdate,
  type EdgezMeshNode,
  type EdgezOrganicMapRef,
} from '@edgez/react-native-sdk';

export function MapScreen({nodes}: {nodes: EdgezMeshNode[]}) {
  const map = useRef<EdgezOrganicMapRef>(null);
  const [region, setRegion] = useState<string>();
  const [download, setDownload] = useState<EdgezMapDownloadUpdate>();
  const [error, setError] = useState('');
  const [perspective3d, setPerspective3d] = useState(false);
  const [night, setNight] = useState(false);
  const markers = useMemo(() => nodes.flatMap(node =>
    node.latitude === undefined || node.longitude === undefined ? [] : [{
      id: node.nodeNum.toString(16),
      label: edgezNodeDisplayName(node),
      latitude: node.latitude,
      longitude: node.longitude,
      marker: node.marker || 'blue',
    }],
  ), [nodes]);

  const toggle3d = () => {
    const enabled = !perspective3d;
    map.current?.setPerspective3d(enabled);
    setPerspective3d(enabled);
  };
  const toggleTheme = () => {
    const enabled = !night;
    map.current?.setMapTheme(enabled ? 'night' : 'day');
    setNight(enabled);
  };

  return <View style={styles.screen}>
    <EdgezOrganicMap
      ref={map}
      nodes={markers}
      zoom={9}
      enableMapDownloads
      style={StyleSheet.absoluteFill}
      onMapRegionAvailable={setRegion}
      onMapDownloadUpdate={update => {setRegion(undefined); setDownload(update);}}
      onMapError={setError}
    />
    <View style={styles.controls}>
      <MapButton label={perspective3d ? '3D' : '2D'} active={perspective3d} onPress={toggle3d} />
      <MapButton label={night ? 'Night' : 'Day'} active={night} onPress={toggleTheme} />
      <MapButton label="Offline" onPress={() => map.current?.findDownloadableRegion()} />
    </View>
    {region ? <View style={styles.prompt}>
      <Text style={styles.promptTitle}>Download map: {region}?</Text>
      <Text style={styles.promptText}>It will be cached for offline use.</Text>
      <View style={styles.row}>
        <MapButton label="Download" active onPress={() => {map.current?.downloadRegion(region); setRegion(undefined);}} />
        <MapButton label="Not now" onPress={() => {map.current?.dismissDownloadRegion(region); setRegion(undefined);}} />
      </View>
    </View> : null}
    {download ? <View style={styles.notice}><Text style={styles.noticeText}>{download.status}</Text></View> : null}
    {error ? <View style={[styles.notice, styles.error]}><Text style={styles.noticeText}>{error}</Text></View> : null}
    <View style={styles.attribution}><Text style={styles.attributionText}>
      {markers.length ? `${markers.length} mesh nodes` : 'No mesh nodes are sharing a location'} · Map data © OpenStreetMap contributors
    </Text></View>
  </View>;
}

function MapButton({label, active = false, onPress}: {label: string; active?: boolean; onPress: () => void}) {
  return <TouchableOpacity style={[styles.button, active && styles.buttonActive]} onPress={onPress}>
    <Text style={styles.buttonText}>{label}</Text>
  </TouchableOpacity>;
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: '#DDE4E9'},
  controls: {position: 'absolute', right: 12, top: 12, gap: 8},
  button: {backgroundColor: '#17263A', borderRadius: 10, paddingHorizontal: 13, paddingVertical: 10, borderWidth: 1, borderColor: '#46617E'},
  buttonActive: {backgroundColor: '#0B746C', borderColor: '#2DD4BF'}, buttonText: {color: '#FFF', fontWeight: '800'},
  prompt: {position: 'absolute', left: 12, right: 12, bottom: 40, backgroundColor: '#101C2D', borderRadius: 14, padding: 14, gap: 8},
  promptTitle: {color: '#FFF', fontWeight: '800'}, promptText: {color: '#A9B7C9'}, row: {flexDirection: 'row', gap: 8},
  notice: {position: 'absolute', left: 12, right: 90, top: 12, backgroundColor: '#101C2DDD', borderRadius: 10, padding: 10},
  error: {backgroundColor: '#7F1D1DDD'}, noticeText: {color: '#FFF'},
  attribution: {position: 'absolute', left: 10, right: 10, bottom: 5}, attributionText: {fontSize: 10, color: '#17263A', textShadowColor: '#FFF', textShadowRadius: 4},
});
