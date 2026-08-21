# EdgeZ Windows example

This host uses the actively supported React Native Windows 0.84 line while
reusing the same Nodes, Messages, and Settings source as the Expo and macOS
examples.

Requirements: Windows 11, Node.js 22.11 or newer, Visual Studio with the v145
C++ toolset, Desktop development with C++, the Windows App SDK workload, and
Developer Mode enabled.

```powershell
npm install
npm run windows:init
npm run start
# In a second terminal:
npm run windows
```

Create a Release build with `npm run build:windows`. The one-time initializer
generates the official RNW project, adds the Bluetooth device capability, and
restores the shared Metro configuration after the RNW generator overwrites it.
