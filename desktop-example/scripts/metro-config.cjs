const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const projectRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(projectRoot, '..');

module.exports = mergeConfig(getDefaultConfig(projectRoot), {
  watchFolders: [repositoryRoot],
  resolver: {
    blockList: [
      new RegExp(`${path.resolve(projectRoot, 'macos', 'build').replace(/[/\\]/g, '/')}.*`),
    ],
    nodeModulesPaths: [path.resolve(projectRoot, 'node_modules')],
    disableHierarchicalLookup: true,
    extraNodeModules: {
      react: path.resolve(projectRoot, 'node_modules/react'),
      'react-native': path.resolve(projectRoot, 'node_modules/react-native'),
      '@react-native-async-storage/async-storage': path.resolve(projectRoot, 'node_modules/@react-native-async-storage/async-storage'),
    },
  },
  transformer: {
    getTransformOptions: async () => ({
      transform: {experimentalImportSupport: false, inlineRequires: true},
    }),
  },
});
