import React from 'react';
import {View, type StyleProp, type ViewStyle} from 'react-native';

export function SafeAreaFrame({children, style}: React.PropsWithChildren<{style?: StyleProp<ViewStyle>}>) {
  return <View style={style}>{children}</View>;
}
