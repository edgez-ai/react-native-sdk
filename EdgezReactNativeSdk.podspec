require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |spec|
  spec.name         = 'EdgezReactNativeSdk'
  spec.version      = package['version']
  spec.summary      = package['description']
  spec.homepage     = 'https://github.com/edgez-ai/react-native-sdk'
  spec.license      = package['license'] || 'MIT'
  spec.authors      = { 'EdgeZ' => 'support@edgez.ai' }
  spec.source       = { :git => 'https://github.com/edgez-ai/react-native-sdk.git', :tag => spec.version.to_s }
  spec.platforms    = { :osx => '14.0' }
  spec.source_files = 'macos/**/*.{h,m,mm}'
  spec.requires_arc = true
  spec.frameworks   = 'CoreBluetooth'
  spec.dependency 'React-Core'
end
