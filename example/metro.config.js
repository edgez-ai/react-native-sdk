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

module.exports = config;
