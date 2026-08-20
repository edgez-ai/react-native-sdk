import React from 'react';
import {ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View} from 'react-native';

export function Card({title, action, children}: React.PropsWithChildren<{title: string; action?: React.ReactNode}>) {
  return <View style={styles.card}>
    <View style={styles.cardHeader}><Text style={styles.title}>{title}</Text>{action}</View>
    {children}
  </View>;
}

export function Row({label, value}: {label: string; value: string}) {
  return <View style={styles.row}><Text style={styles.muted}>{label}</Text><Text style={styles.value}>{value}</Text></View>;
}

export function Button({label, onPress, secondary, disabled}: {label: string; onPress: () => void | Promise<void>; secondary?: boolean; disabled?: boolean}) {
  return <TouchableOpacity disabled={disabled} style={[styles.button, secondary && styles.secondary, disabled && styles.disabled]} onPress={() => void onPress()}>
    <Text style={styles.buttonText}>{label}</Text>
  </TouchableOpacity>;
}

export function Field({label, value, onChangeText, secureTextEntry, keyboardType}: {label: string; value: string; onChangeText: (value: string) => void; secureTextEntry?: boolean; keyboardType?: 'default'|'numeric'|'decimal-pad'}) {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput style={styles.input} value={value} onChangeText={onChangeText} secureTextEntry={secureTextEntry} keyboardType={keyboardType} placeholderTextColor="#738095" /></View>;
}

export function ToggleRow({label, detail, value, onValueChange, disabled}: {label: string; detail?: string; value: boolean; onValueChange: (value: boolean) => void; disabled?: boolean}) {
  return <View style={styles.toggle}><View style={styles.toggleText}><Text style={styles.value}>{label}</Text>{detail ? <Text style={styles.muted}>{detail}</Text> : null}</View><Switch value={value} onValueChange={onValueChange} disabled={disabled} trackColor={{true: '#0F9F91'}} /></View>;
}

export function Choices<T extends string | number>({label, values, value, titleFor = String, onChange}: {label: string; values: readonly T[]; value: T; titleFor?: (value: T) => string; onChange: (value: T) => void}) {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.choices}>
    {values.map(option => <TouchableOpacity key={String(option)} style={[styles.choice, option === value && styles.choiceActive]} onPress={() => onChange(option)}><Text style={[styles.choiceText, option === value && styles.choiceTextActive]}>{titleFor(option)}</Text></TouchableOpacity>)}
  </ScrollView></View>;
}

export const ui = StyleSheet.create({
  screen: {flex: 1, backgroundColor: '#07101E'}, content: {padding: 16, gap: 12},
  heading: {color: '#FFF', fontWeight: '800', fontSize: 26}, muted: {color: '#8CA0BA'},
  actions: {flexDirection: 'row', flexWrap: 'wrap', gap: 8}, sectionTabs: {flexDirection: 'row', gap: 8},
});

const styles = StyleSheet.create({
  card: {backgroundColor: '#101C2D', borderRadius: 16, padding: 16, gap: 10, borderWidth: 1, borderColor: '#203249'},
  cardHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8}, title: {color: '#FFF', fontSize: 18, fontWeight: '700', flexShrink: 1},
  row: {flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 3}, muted: {color: '#8CA0BA', flexShrink: 1}, value: {color: '#EEF5FF', fontWeight: '600', flexShrink: 1},
  button: {backgroundColor: '#0F9F91', paddingHorizontal: 15, paddingVertical: 12, borderRadius: 10, alignItems: 'center'}, secondary: {backgroundColor: '#24344A'}, disabled: {opacity: 0.45}, buttonText: {color: '#FFF', fontWeight: '700'},
  field: {gap: 6}, label: {color: '#B7C6D9', fontWeight: '600'}, input: {backgroundColor: '#0A1422', borderColor: '#2A3C54', borderWidth: 1, borderRadius: 10, padding: 12, color: '#FFF'},
  toggle: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 4}, toggleText: {flex: 1, gap: 2},
  choices: {gap: 7, paddingRight: 8}, choice: {borderWidth: 1, borderColor: '#354A64', borderRadius: 99, paddingVertical: 8, paddingHorizontal: 12}, choiceActive: {backgroundColor: '#0F766E', borderColor: '#2DD4BF'}, choiceText: {color: '#AFC0D5', fontWeight: '600'}, choiceTextActive: {color: '#FFF'},
});
