import {EdgezNativeTransport, type EdgezPlatformTransport} from './EdgezMeshSdk';

export interface H7608ProvisioningNetwork {
  ssid: string;
  bssid: string;
  rssi: number;
  secure: boolean;
}

export interface H7608ProvisioningInfo {
  ok: boolean;
  model: 'HT-H7608-V1';
  serial: string;
  configured: boolean;
}

export interface H7608ProvisioningConfig {
  clientId: string;
  username: string;
  password: string;
  projectId: string;
  channel: string;
  meshId: string;
  passphrase: string;
  country: string;
  halowChannel: number;
  softapSsid?: string;
  latitude?: number | null;
  longitude?: number | null;
}

export interface H7608UpstreamNetwork {
  ssid: string;
  bssid?: string;
  rssi: number;
  secure: boolean;
}

export class H7608ProvisioningDevice {
  readonly kind = 'h7608' as const;
  private connected = false;

  constructor(
    readonly network: H7608ProvisioningNetwork,
    private readonly transport: EdgezPlatformTransport = new EdgezNativeTransport(),
  ) {}

  get name(): string { return this.network.ssid; }

  static async scan(transport: EdgezPlatformTransport = new EdgezNativeTransport()): Promise<H7608ProvisioningDevice[]> {
    const networks = await transport.invoke<H7608ProvisioningNetwork[]>('scanH7608ProvisioningNetworks');
    return networks.map(network => new H7608ProvisioningDevice(network, transport));
  }

  async connect(pop: string): Promise<H7608ProvisioningInfo> {
    await this.transport.invoke('connectH7608ProvisioningNetwork', {ssid: this.network.ssid, passphrase: pop});
    this.connected = true;
    const info = await this.request<H7608ProvisioningInfo>('GET', '/info', pop);
    const advertisedSerial = this.network.ssid.slice('PROV_'.length).toUpperCase();
    if (!info.ok || info.model !== 'HT-H7608-V1' || info.serial !== advertisedSerial) {
      await this.disconnect();
      throw new Error('The connected SoftAP is not the selected H7608');
    }
    return info;
  }

  async configure(config: H7608ProvisioningConfig, pop: string): Promise<{ok: boolean; persisted?: boolean; error?: string}> {
    if (!this.connected) throw new Error('The H7608 SoftAP is not connected');
    return this.request('POST', '/config', pop, JSON.stringify(config));
  }

  async scanUpstreamWifi(pop: string): Promise<H7608UpstreamNetwork[]> {
    const response = await this.request<{results?: Array<{ssid?: string; bssid?: string; signal?: number; encryption?: {enabled?: boolean}}>}>('GET', '/upstream/scan', pop);
    return (response.results ?? []).filter(result => Boolean(result.ssid)).map(result => ({
      ssid: result.ssid!, bssid: result.bssid, rssi: result.signal ?? -127,
      secure: result.encryption?.enabled !== false,
    }));
  }

  provisionUpstreamWifi(ssid: string, passphrase: string, pop: string): Promise<{ok: boolean; persisted?: boolean; error?: string}> {
    return this.request('POST', '/upstream', pop, JSON.stringify({ssid, passphrase}));
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.transport.invoke('disconnectH7608ProvisioningNetwork');
  }

  private async request<T>(method: 'GET' | 'POST', path: '/info' | '/config' | '/upstream' | '/upstream/scan', pop: string, body = ''): Promise<T> {
    const response = await this.transport.invoke<string>('requestH7608Provisioning', {method, path, pop, body});
    return JSON.parse(response) as T;
  }
}
