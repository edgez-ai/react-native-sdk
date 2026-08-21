import React from 'react';
import type {StyleProp, ViewStyle} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';

export function SafeAreaFrame({children, style}: React.PropsWithChildren<{style?: StyleProp<ViewStyle>}>) {
  return <SafeAreaProvider><SafeAreaView style={style} edges={['top', 'bottom']}>{children}</SafeAreaView></SafeAreaProvider>;
}
