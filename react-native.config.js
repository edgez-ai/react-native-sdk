module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath: 'import ai.edgez.react_native_sdk.EdgezReactNativeSdkPackage;',
        packageInstance: 'new EdgezReactNativeSdkPackage()',
      },
      macos: {},
      windows: {
        sourceDir: './windows',
        solutionFile: 'EdgezReactNativeSdk.sln',
        projects: [{
          projectFile: 'EdgezReactNativeSdk/EdgezReactNativeSdk.vcxproj',
          directDependency: true,
        }],
      },
    },
  },
};
