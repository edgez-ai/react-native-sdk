import React, {forwardRef, useImperativeHandle, useRef} from 'react';
import {
  findNodeHandle,
  Platform,
  requireNativeComponent,
  Text,
  UIManager,
  View,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

const viewName = 'EdgezOrganicMapView';

export interface EdgezMapNode {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  marker?: string;
}

export interface EdgezMapCamera {
  latitude: number;
  longitude: number;
  zoom: number;
}

export interface EdgezMapDownloadUpdate {
  regionId: string;
  status: string;
  progress?: number;
  finished: boolean;
  failed: boolean;
}

export type EdgezMapTheme = 'day' | 'night';

export interface EdgezOrganicMapRef {
  setCamera(camera: EdgezMapCamera): void;
  downloadRegion(regionId: string): void;
  dismissDownloadRegion(regionId: string): void;
  findDownloadableRegion(): void;
  getCamera(): void;
  setPerspective3d(enabled: boolean): void;
  setMapTheme(theme: EdgezMapTheme): void;
  setSatelliteMode(options: {
    enabled: boolean;
    tileUrl?: string;
    cacheSizeMb?: number;
    areaOpacity?: number;
  }): void;
  setBundledSatelliteMode(enabled: boolean, assetName: string): void;
}

export interface EdgezOrganicMapProps {
  nodes: EdgezMapNode[];
  centerLatitude?: number;
  centerLongitude?: number;
  zoom?: number;
  enableMapDownloads?: boolean;
  style?: StyleProp<ViewStyle>;
  onMapReady?: () => void;
  onCameraChanged?: (camera: EdgezMapCamera) => void;
  onMapRegionAvailable?: (regionId: string) => void;
  onMapDownloadUpdate?: (update: EdgezMapDownloadUpdate) => void;
  onMapError?: (message: string) => void;
}

interface NativeProps extends Omit<EdgezOrganicMapProps,
  'onMapReady' | 'onCameraChanged' | 'onMapRegionAvailable' | 'onMapDownloadUpdate' | 'onMapError'> {
  onMapReady?: (event: NativeSyntheticEvent<Record<string, never>>) => void;
  onCameraChanged?: (event: NativeSyntheticEvent<EdgezMapCamera>) => void;
  onMapRegionAvailable?: (event: NativeSyntheticEvent<{regionId: string}>) => void;
  onMapDownloadUpdate?: (event: NativeSyntheticEvent<EdgezMapDownloadUpdate>) => void;
  onMapError?: (event: NativeSyntheticEvent<{message: string}>) => void;
}

const NativeMap = requireNativeComponent<NativeProps>(viewName);

export const EdgezOrganicMap = forwardRef<EdgezOrganicMapRef, EdgezOrganicMapProps>(
  function EdgezOrganicMap(props, forwardedRef) {
    const nativeRef = useRef<React.ElementRef<typeof NativeMap>>(null);

    const dispatch = (name: string, args: unknown[] = []) => {
      const handle = findNodeHandle(nativeRef.current);
      const command = UIManager.getViewManagerConfig(viewName)?.Commands?.[name];
      if (handle == null || command == null) return;
      UIManager.dispatchViewManagerCommand(handle, command, args);
    };

    useImperativeHandle(forwardedRef, () => ({
      setCamera: camera => dispatch('setCamera', [camera.latitude, camera.longitude, camera.zoom]),
      downloadRegion: regionId => dispatch('downloadRegion', [regionId]),
      dismissDownloadRegion: regionId => dispatch('dismissDownloadRegion', [regionId]),
      findDownloadableRegion: () => dispatch('findDownloadableRegion'),
      getCamera: () => dispatch('getCamera'),
      setPerspective3d: enabled => dispatch('setPerspective3d', [enabled]),
      setMapTheme: theme => dispatch('setMapTheme', [theme]),
      setSatelliteMode: options => dispatch('setSatelliteMode', [
        options.enabled,
        options.tileUrl ?? '',
        options.cacheSizeMb ?? 256,
        options.areaOpacity ?? 35,
      ]),
      setBundledSatelliteMode: (enabled, assetName) =>
        dispatch('setBundledSatelliteMode', [enabled, assetName]),
    }));

    if (Platform.OS !== 'android') {
      return <View style={props.style}><Text>EdgeZ Organic Maps is currently available on Android.</Text></View>;
    }

    return <NativeMap
      ref={nativeRef}
      nodes={props.nodes}
      centerLatitude={props.centerLatitude}
      centerLongitude={props.centerLongitude}
      zoom={props.zoom ?? 9}
      enableMapDownloads={props.enableMapDownloads ?? false}
      style={props.style}
      onMapReady={() => props.onMapReady?.()}
      onCameraChanged={event => props.onCameraChanged?.(event.nativeEvent)}
      onMapRegionAvailable={event => props.onMapRegionAvailable?.(event.nativeEvent.regionId)}
      onMapDownloadUpdate={event => props.onMapDownloadUpdate?.(event.nativeEvent)}
      onMapError={event => props.onMapError?.(event.nativeEvent.message)}
    />;
  },
);
