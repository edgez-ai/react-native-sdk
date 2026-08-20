const path = require('node:path');
const {getDefaultConfig} = require('expo/metro-config');

const projectRoot = __dirname;
const sdkRoot = path.resolve(projectRoot, '..');
const config = getDefaultConfig(projectRoot);

// The example consumes the SDK through `file:..`, which npm represents as a
// symlink. Metro resolves source files at their real SDK path, so explicitly
// watch that directory while resolving all JavaScript dependencies from the
// example. This also ensures React and React Native have only one instance.
config.watchFolders = [...new Set([...config.watchFolders, sdkRoot])];
config.resolver.nodeModulesPaths = [path.join(projectRoot, 'node_modules')];
// Modules imported by ../src would otherwise resolve hierarchically from the
// SDK repository first. Pin runtime singletons to the Expo app so Metro never
// bundles the SDK's development copy of React Native or a separate native-
// module wrapper whose registry does not match the installed application.
const singletonPackages = [
  'react',
  'react-native',
  '@react-native-async-storage/async-storage',
];
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const packageName = singletonPackages.find(
    name => moduleName === name || moduleName.startsWith(`${name}/`),
  );
  if (packageName) {
    const subpath = moduleName.slice(packageName.length);
    const appModule = path.join(projectRoot, 'node_modules', packageName, subpath);
    return context.resolveRequest(context, appModule, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
