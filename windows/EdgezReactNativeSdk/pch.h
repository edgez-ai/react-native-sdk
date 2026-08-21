// pch.h : include file for standard system include files,
// or project specific include files that are used frequently, but
// are changed infrequently
//

#pragma once

#include "targetver.h"

#define NOMINMAX 1
#define WIN32_LEAN_AND_MEAN 1
#define WINRT_LEAN_AND_MEAN 1

// Windows Header Files
#include <windows.h>
#undef GetCurrentTime
#include <unknwn.h>

// WinRT Header Files
#include <winrt/base.h>
#include <CppWinRTIncludes.h>
#include <winrt/Microsoft.ReactNative.h>
#include <winrt/Windows.Devices.Bluetooth.h>
#include <winrt/Windows.Devices.Bluetooth.Advertisement.h>
#include <winrt/Windows.Devices.Bluetooth.GenericAttributeProfile.h>
#include <winrt/Windows.Storage.Streams.h>
#include <winrt/Windows.Security.Cryptography.h>

// C RunTime Header Files
#include <malloc.h>
#include <memory.h>
#include <stdlib.h>
#include <tchar.h>

#include <algorithm>
#include <chrono>
#include <coroutine>
#include <exception>
#include <iomanip>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

// Reference additional headers your project requires here
