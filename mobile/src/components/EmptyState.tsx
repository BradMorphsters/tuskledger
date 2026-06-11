/**
 * EmptyState — centered glyph + title + supporting copy for screens
 * and lists with nothing to show yet.
 */
import { StyleSheet, Text, View } from 'react-native';
import { space, type } from '../theme';

interface Props {
  icon?: string;
  title: string;
  message?: string;
}

export default function EmptyState({ icon = '🐘', title, message }: Props) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.icon}>{icon}</Text>
      <Text style={[type.h2, styles.title]}>{title}</Text>
      {message ? (
        <Text style={[type.small, styles.message]}>{message}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    paddingVertical: space(10),
    paddingHorizontal: space(8),
  },
  icon: {
    fontSize: 34,
    marginBottom: space(3),
    opacity: 0.85,
  },
  title: {
    textAlign: 'center',
  },
  message: {
    textAlign: 'center',
    marginTop: space(2),
  },
});
