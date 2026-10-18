import {NativeModules, Platform} from 'react-native';

export interface EdgezCurrentLocation {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestampMs: number;
}

type NativeLocationModule = {
  getCurrentLocation(arguments_: {timeoutMs: number}): Promise<EdgezCurrentLocation>;
};

function nativeLocationModule(): NativeLocationModule {
  const native = NativeModules.EdgezReactNativeSdk as NativeLocationModule | undefined;
  if (!native?.getCurrentLocation) throw new Error('@edgez/react-native-sdk native location support is unavailable');
  return native;
}

export async function getCurrentLocation(timeoutMs = 20_000): Promise<EdgezCurrentLocation> {
  if (Platform.OS !== 'android') throw new Error('Fresh native location currently requires Android');
  const boundedTimeout = Math.max(1_000, Math.min(60_000, Math.round(timeoutMs)));
  return nativeLocationModule().getCurrentLocation({timeoutMs: boundedTimeout});
}
