import {parseAppBundleManifest} from '../src/appUpdates';

const payload = {
  schemaVersion: 1,
  platform: 'android',
  updateId: 'abc123',
  runtimeVersion: 'live-stocking-android-1',
  releaseTag: 'v0.0.4',
  bundleAssetName: 'live-stocking.android.bundle',
  sha256: 'a'.repeat(64),
  size: 1024,
  createdAt: '2026-09-26T11:00:00.000Z',
};

describe('app bundle manifests', () => {
  it('parses the publisher-signed envelope', () => {
    const signedPayload = Buffer.from(JSON.stringify(payload)).toString('base64');
    expect(parseAppBundleManifest({schemaVersion: 1, signedPayload, signature: 'AQID'})).toMatchObject({
      ...payload,
      signedPayload,
      signature: 'AQID',
    });
  });

  it('rejects an unsigned manifest', () => {
    expect(() => parseAppBundleManifest(payload)).toThrow('signed app bundle manifest');
  });
});
