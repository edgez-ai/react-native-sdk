import {readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

const windowsDirectory = path.resolve('windows');
const entries = await readdir(windowsDirectory, {withFileTypes: true});
const packageDirectory = entries.find(entry => entry.isDirectory() && entry.name.endsWith('.Package'));

if (!packageDirectory) throw new Error('Could not find the generated Windows package project');

const manifestPath = path.join(windowsDirectory, packageDirectory.name, 'Package.appxmanifest');
const manifest = await readFile(manifestPath, 'utf8');

if (!manifest.includes('DeviceCapability Name="bluetooth"')) {
  const updated = manifest.replace(
    '</Capabilities>',
    '    <DeviceCapability Name="bluetooth" />\n  </Capabilities>',
  );
  if (updated === manifest) throw new Error('Could not add Bluetooth capability to Package.appxmanifest');
  await writeFile(manifestPath, updated);
}

await writeFile(
  path.resolve('metro.config.js'),
  "module.exports = require('./scripts/metro-config.cjs');\n",
);

await writeFile(
  path.resolve('tsconfig.json'),
  '{\n  "extends": "./tsconfig.edgez.json"\n}\n',
);

console.log(`Configured Bluetooth capability in ${manifestPath}`);
console.log('Restored the shared Windows Metro configuration');
console.log('Restored the EdgeZ Windows TypeScript configuration');
