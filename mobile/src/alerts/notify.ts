/**
 * Local-notification wrapper around expo-notifications.
 *
 * Why a wrapper: the native module is absent in Expo Go and in any
 * build made before the dependency was added, and we never want a
 * missing module to break sync. Every export here degrades to a no-op
 * (returning `false`) when the module can't be loaded, and the import is
 * lazy so the failure happens at first use rather than at bundle time.
 *
 * Local only: nothing here talks to APNs or any server. That is also why
 * app.json lists plugins/withoutPushEntitlement.js: prebuild auto-applies
 * expo-notifications' config plugin (even unlisted) and it always adds the
 * aps-environment push entitlement, which the ad-hoc provisioning profile
 * doesn't carry and which local notifications never need. The phone
 * decides what to say from its own mirror at sync time and presents the
 * notification immediately (trigger: null). No device token leaves the
 * phone, which keeps the "your data stays on your home network" promise.
 */
type NotificationsModule = typeof import('expo-notifications');

let mod: NotificationsModule | null | undefined;

async function load(): Promise<NotificationsModule | null> {
  if (mod !== undefined) return mod;
  try {
    mod = (await import('expo-notifications')) as NotificationsModule;
    // Show alerts even while the app is in the foreground (default iOS
    // behaviour is to suppress them when the app is active).
    mod.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
  } catch {
    mod = null;
  }
  return mod;
}

/** True when the native module is available in this build. */
export async function notificationsAvailable(): Promise<boolean> {
  return (await load()) !== null;
}

/** Current permission status, or 'unavailable' when the module is missing. */
export async function permissionStatus(): Promise<'granted' | 'denied' | 'undetermined' | 'unavailable'> {
  const m = await load();
  if (!m) return 'unavailable';
  try {
    const p = await m.getPermissionsAsync();
    if (p.granted) return 'granted';
    return p.canAskAgain ? 'undetermined' : 'denied';
  } catch {
    return 'unavailable';
  }
}

/** Ask the OS for permission. Resolves true when granted. */
export async function requestPermission(): Promise<boolean> {
  const m = await load();
  if (!m) return false;
  try {
    const p = await m.requestPermissionsAsync();
    return !!p.granted;
  } catch {
    return false;
  }
}

/** Present a local notification now. Resolves true when scheduled. */
export async function presentNow(title: string, body: string, data?: Record<string, unknown>): Promise<boolean> {
  const m = await load();
  if (!m) return false;
  try {
    await m.scheduleNotificationAsync({
      content: { title, body, data, sound: false },
      trigger: null,
    });
    return true;
  } catch {
    return false;
  }
}
