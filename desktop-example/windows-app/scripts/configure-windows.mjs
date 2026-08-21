import {readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

const windowsDirectory = path.resolve('windows');
const entries = await readdir(windowsDirectory, {withFileTypes: true});
const packageDirectory = entries.find(entry => entry.isDirectory() && entry.name.endsWith('.Package'));

if (!packageDirectory) throw new Error('Could not find the generated Windows package project');

const appName = packageDirectory.name.replace(/\.Package$/, '');
const appProjectPath = path.join(windowsDirectory, appName, `${appName}.vcxproj`);
let appProject = await readFile(appProjectPath, 'utf8');

if (!appProject.includes('<WindowsPackageType>None</WindowsPackageType>')) {
  appProject = appProject.replace(
    '<AppxPackage>false</AppxPackage>',
    '<AppxPackage>false</AppxPackage>\n    <WindowsPackageType>None</WindowsPackageType>\n    <WindowsAppSDKSelfContained>true</WindowsAppSDKSelfContained>',
  );
  if (!appProject.includes('<WindowsPackageType>None</WindowsPackageType>')) {
    throw new Error(`Could not configure unpackaged output in ${appProjectPath}`);
  }
  await writeFile(appProjectPath, appProject);
}

const appHeaderPath = path.join(windowsDirectory, appName, 'pch.h');
let appHeader = await readFile(appHeaderPath, 'utf8');
if (!appHeader.includes('<winrt/Windows.ApplicationModel.Core.h>')) {
  appHeader = appHeader.replace(
    '#include <winrt/base.h>',
    '#include <winrt/base.h>\n#include <winrt/Windows.ApplicationModel.Core.h>',
  );
  if (!appHeader.includes('<winrt/Windows.ApplicationModel.Core.h>')) {
    throw new Error(`Could not add the unpackaged storage header to ${appHeaderPath}`);
  }
  await writeFile(appHeaderPath, appHeader);
}

const appSourcePath = path.join(windowsDirectory, appName, `${appName}.cpp`);
let appSource = await readFile(appSourcePath, 'utf8');
if (!appSource.includes('ConfigureUnpackagedAsyncStorage')) {
  const storageSetup = `
namespace {
void ConfigureUnpackagedAsyncStorage() {
  wchar_t *localAppData = nullptr;
  size_t length = 0;
  if (_wdupenv_s(&localAppData, &length, L"LOCALAPPDATA") != 0 || !localAppData) {
    winrt::throw_last_error();
  }

  std::wstring storageDirectory{localAppData};
  free(localAppData);
  storageDirectory += L"\\\\EdgezWindowsExample";
  if (!CreateDirectoryW(storageDirectory.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) {
    winrt::throw_last_error();
  }

  auto databasePath = storageDirectory + L"\\\\AsyncStorage.db";
  winrt::Windows::ApplicationModel::Core::CoreApplication::Properties().Insert(
      L"React-Native-Community-Async-Storage-Database-Path",
      winrt::box_value(winrt::hstring{databasePath}));
}
} // namespace
`;
  appSource = appSource.replace('#include "NativeModules.h"', `#include "NativeModules.h"\n${storageSetup}`);
  appSource = appSource.replace(
    'winrt::init_apartment(winrt::apartment_type::single_threaded);',
    'winrt::init_apartment(winrt::apartment_type::single_threaded);\n  ConfigureUnpackagedAsyncStorage();',
  );
  if (!appSource.includes('ConfigureUnpackagedAsyncStorage();')) {
    throw new Error(`Could not configure unpackaged AsyncStorage in ${appSourcePath}`);
  }
  await writeFile(appSourcePath, appSource);
}

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
console.log(`Configured self-contained portable output in ${appProjectPath}`);
console.log(`Configured unpackaged AsyncStorage in ${appSourcePath}`);
console.log('Restored the shared Windows Metro configuration');
console.log('Restored the EdgeZ Windows TypeScript configuration');
