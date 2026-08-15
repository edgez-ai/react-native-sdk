module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath: 'import ai.edgez.react_native_sdk.EdgezReactNativeSdkPackage;',
        packageInstance: 'new EdgezReactNativeSdkPackage()',
      },
    },
  },
};
