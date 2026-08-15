const {
  withAppBuildGradle,
  withSettingsGradle,
} = require('expo/config-plugins');

const NODE_RESOLVER = `def resolveEdgezNode = {
  def candidates = [
    providers.gradleProperty("edgezNodeExecutable").getOrNull(),
    System.getenv("NODE_BINARY"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ].findAll { it }
  def nvmRoot = new File(System.getProperty("user.home"), ".nvm/versions/node")
  if (nvmRoot.isDirectory()) {
    def nvmVersions = nvmRoot.listFiles()
      ?.findAll { it.isDirectory() }
      ?.sort { left, right -> right.lastModified() <=> left.lastModified() }
      ?.collect { new File(it, "bin/node").absolutePath } ?: []
    candidates.addAll(nvmVersions)
  }
  candidates.find { new File(it).canExecute() } ?: "node"
}
def edgezNode = resolveEdgezNode()
`;

function addOnce(source, anchor, addition, description) {
  if (source.includes(addition.trim())) return source;
  if (!source.includes(anchor)) {
    throw new Error(`Cannot add ${description}; missing anchor: ${anchor}`);
  }
  return source.replace(anchor, `${anchor}${addition}`);
}

module.exports = function withAndroidStudioNode(config) {
  config = withSettingsGradle(config, gradleConfig => {
    let contents = addOnce(
      gradleConfig.modResults.contents,
      'pluginManagement {\n',
      NODE_RESOLVER.split('\n')
        .map(line => (line ? `  ${line}` : line))
        .join('\n'),
      'the Android Studio Node resolver',
    );
    contents = contents.replaceAll(
      'commandLine("node",',
      'commandLine(edgezNode,',
    );
    gradleConfig.modResults.contents = contents;
    return gradleConfig;
  });

  config = withAppBuildGradle(config, gradleConfig => {
    let contents = addOnce(
      gradleConfig.modResults.contents,
      'apply plugin: "com.facebook.react"\n',
      `\n${NODE_RESOLVER}\n`,
      'the Android Studio Node resolver',
    );
    contents = contents.replaceAll('["node",', '[edgezNode,');
    contents = addOnce(
      contents,
      'react {',
      '\n    nodeExecutableAndArgs = [edgezNode]',
      'the React Native Node executable',
    );
    gradleConfig.modResults.contents = contents;
    return gradleConfig;
  });

  return config;
};
