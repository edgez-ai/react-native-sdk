const espIdfProvisioningPlugin = require('@orbital-systems/react-native-esp-idf-provisioning/app.plugin');
const blePlxPluginModule = require('react-native-ble-plx/app.plugin');

const withBlePlx = blePlxPluginModule.default || blePlxPluginModule;

/**
 * Installs the native BLE and SoftAP capabilities used by EdgeZ provisioning.
 * Applications only need to list @edgez/react-native-sdk in their Expo plugins.
 */
module.exports = function withEdgezReactNativeSdk(config) {
  config = espIdfProvisioningPlugin(config, {transport: 'both'});
  return withBlePlx(config);
};
