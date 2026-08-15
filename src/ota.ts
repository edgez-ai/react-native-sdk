export class EdgezOtaRelease {
  constructor(readonly version: string, readonly size: number, readonly url: string) {}

  static fromJson(json: Record<string, unknown>): EdgezOtaRelease {
    const version = typeof json.version === 'string' ? json.version.trim() : '';
    const size = typeof json.size === 'number' ? Math.trunc(json.size) : 0;
    const url = typeof json.url === 'string' ? json.url : '';
    if (!version) throw new Error('OTA manifest has no firmware version');
    if (size <= 0) throw new Error('OTA manifest has an invalid image size');
    if (!/^https?:\/\/[^/]+/i.test(url)) throw new Error('OTA manifest has an invalid image URL');
    return new EdgezOtaRelease(version, size, url);
  }

  isNewerThan(currentVersion: string): boolean {
    const components = (value: string) => value.replace(/^v/, '').split(/[.\-_]/).map(Number).filter(Number.isInteger);
    const current = components(currentVersion), available = components(this.version);
    if (!current.length || !available.length) return currentVersion !== this.version;
    for (let index = 0; index < Math.max(current.length, available.length); index++) {
      const left = current[index] ?? 0, right = available[index] ?? 0;
      if (left !== right) return right > left;
    }
    return false;
  }
}
