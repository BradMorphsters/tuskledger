import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Lazy / optional load — `requireOptionalNativeModule` returns null
 * when the native side isn't linked into the current binary (Expo Go,
 * or any dev build where the widget extension target hasn't been
 * added yet). That keeps the app booting normally even when the
 * widget plumbing isn't wired up.
 *
 * Callers (publishSnapshot in src/widget/snapshot.ts) already swallow
 * thrown errors, so the worst case is a no-op widget refresh.
 */
const WidgetBridge = requireOptionalNativeModule('WidgetBridge');

export async function writeSnapshot(json: string): Promise<void> {
  if (!WidgetBridge) return;
  return WidgetBridge.writeSnapshot(json);
}

export async function reloadAll(): Promise<void> {
  if (!WidgetBridge) return;
  return WidgetBridge.reloadAll();
}
