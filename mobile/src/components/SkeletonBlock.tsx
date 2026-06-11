/**
 * SkeletonBlock — subtle loading shimmer (an opacity pulse via a
 * reanimated loop; an actual translating gradient would need
 * expo-linear-gradient, which isn't installed). Reads from the local
 * SQLite mirror are fast, so these usually flash for a frame or two —
 * the pulse keeps that flash from looking like a glitch.
 */
import { useEffect } from 'react';
import { DimensionValue, ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { colors } from '../theme';

interface Props {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  style?: ViewStyle;
}

export default function SkeletonBlock({
  width = '100%',
  height = 16,
  radius = 8,
  style,
}: Props) {
  const opacity = useSharedValue(0.45);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.9, { duration: 650 }),
        withTiming(0.45, { duration: 650 }),
      ),
      -1,
    );
  }, [opacity]);

  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      style={[
        {
          width,
          height,
          borderRadius: radius,
          backgroundColor: colors.surfaceElevated,
        },
        animated,
        style,
      ]}
    />
  );
}
