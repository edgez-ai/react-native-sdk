module.exports = {
  expo: {
    name: 'EdgeZ Mesh SDK Example',
    slug: 'edgez-react-native-sdk-example',
    scheme: 'edgez-mesh',
    version: '0.1.0',
    orientation: 'portrait',
    userInterfaceStyle: 'dark',
    android: {
      package: 'ai.edgez.react_native_sdk_example',
      permissions: [
        'android.permission.BLUETOOTH_SCAN',
        'android.permission.BLUETOOTH_CONNECT',
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.RECORD_AUDIO',
        'android.permission.POST_NOTIFICATIONS',
      ],
    },
    plugins: ['./plugins/withAndroidStudioNode', './plugins/withOrganicMaps'],
  },
};
