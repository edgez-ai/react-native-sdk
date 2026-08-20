import type {EdgezMeshNode, EdgezSensorData} from '@edgez/react-native-sdk';

export const markerColors: Record<string, string> = {
  default: '#94A3B8', red: '#F87171', blue: '#60A5FA', purple: '#C084FC',
  yellow: '#FACC15', pink: '#F472B6', brown: '#A78B71', green: '#4ADE80',
  orange: '#FB923C', deep_purple: '#8B5CF6', light_blue: '#38BDF8',
  cyan: '#22D3EE', teal: '#2DD4BF', lime: '#A3E635', deep_orange: '#F97316',
  gray: '#9CA3AF', blue_gray: '#78909C',
};

export const markerOptions = ['blue', 'green', 'cyan', 'orange', 'red', 'purple', 'yellow'];

export function halowFrequenciesKhz(country: string, bandwidthMhz: number): number[] {
  const range = (start: number, end: number, step: number) => {
    const values: number[] = [];
    for (let value = start; value <= end; value += step) values.push(value);
    return values;
  };
  if (country === 'US') {
    if (bandwidthMhz === 1) return range(902500, 927500, 1000);
    if (bandwidthMhz === 2) return range(903000, 927000, 2000);
    if (bandwidthMhz === 4) return range(904000, 926000, 4000);
    if (bandwidthMhz === 8) return range(908000, 924000, 8000);
  }
  if (country === 'JP') {
    if (bandwidthMhz === 1) return range(920500, 927500, 1000);
    if (bandwidthMhz === 2) return range(921000, 927000, 2000);
    if (bandwidthMhz === 4) return [922000, 926000];
    if (bandwidthMhz === 8) return [924000];
  }
  if (country === 'EU') {
    if (bandwidthMhz === 1) return range(863500, 867500, 1000);
    if (bandwidthMhz === 2) return [864000, 866000];
    if (bandwidthMhz === 4) return [865000];
  }
  return [];
}

export function halowBandwidthOptions(country: string): number[] {
  return [1, 2, 4, 8].filter(value => halowFrequenciesKhz(country, value).length > 0);
}

export function halowFrequencyLabel(country: string, frequencyKhz: number): string {
  const base = country === 'US' ? 902000 : country === 'JP' ? 920000 : country === 'EU' ? 863000 : frequencyKhz;
  return `Ch ${Math.trunc((frequencyKhz - base) / 500)} · ${(frequencyKhz / 1000).toFixed(3)} MHz`;
}

export function frequencyForChannel(country: string, channel: number): number | undefined {
  if (channel <= 0) return undefined;
  const base = ['AU', 'CA', 'NZ', 'US'].includes(country) ? 902000
    : ['EU', 'GB', 'IN'].includes(country) ? 863000
      : country === 'JP' ? 916500 : country === 'KR' ? 917500 : undefined;
  return base === undefined ? undefined : base + channel * 500;
}

export function lastSeenAge(timestampMs: number): string {
  if (!timestampMs) return 'never';
  const seconds = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export function sensorSummary(data?: EdgezSensorData): string | undefined {
  if (!data) return undefined;
  const values = [
    data.temperature === undefined ? '' : `${data.temperature.toFixed(1)} C`,
    data.humidity === undefined ? '' : `${data.humidity.toFixed(1)}%`,
    data.pressure === undefined ? '' : `${data.pressure.toFixed(1)} hPa`,
    data.vibrationAverage === undefined ? '' : `score ${data.vibrationAverage.toFixed(1)}`,
  ].filter(Boolean);
  return values.length ? `Sensor ${values.join(' · ')}` : 'Sensor data received';
}

export function nodeMarkerColor(node: EdgezMeshNode): string {
  return markerColors[node.marker] ?? markerColors.default!;
}
