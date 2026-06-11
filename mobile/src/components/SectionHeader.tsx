/**
 * SectionHeader — 11pt UPPERCASE letterspaced label that sits above a
 * Card, with an optional right-side slot (count, "See all", etc.).
 */
import { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { space, type } from '../theme';

interface Props {
  label: string;
  right?: ReactNode;
  /** Extra top margin — sections after the first want breathing room. */
  topGap?: boolean;
}

export default function SectionHeader({ label, right, topGap = true }: Props) {
  return (
    <View style={[styles.row, topGap && styles.topGap]}>
      <Text style={type.caption}>{label}</Text>
      {right ?? null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginBottom: space(2),
  },
  topGap: {
    marginTop: space(6),
  },
});
