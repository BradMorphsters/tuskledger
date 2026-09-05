/**
 * Config plugin: strip the iOS push entitlement that expo-notifications adds.
 *
 * Why this exists: @expo/prebuild-config auto-applies the config plugin of
 * every installed "versioned SDK package" — expo-notifications included —
 * even when it is NOT listed in app.json `plugins`. That plugin always sets
 * `aps-environment` (Apple Push) in the entitlements, and the ad-hoc
 * provisioning profile for this app doesn't carry the Push Notifications
 * capability, so the EAS build fails at signing.
 *
 * Tusk Ledger's alerts are LOCAL notifications decided on the phone after
 * each sync (src/alerts/). They need the expo-notifications native module
 * but not APNs, so the entitlement is pure liability. User plugins run
 * after prebuild's built-ins in the entitlements mod chain, so deleting the
 * key here wins.
 *
 * If server push is ever wanted, delete this plugin from app.json and let
 * EAS add the capability to the App ID / profile.
 */
const { withEntitlementsPlist } = require('expo/config-plugins');

module.exports = function withoutPushEntitlement(config) {
  return withEntitlementsPlist(config, (c) => {
    delete c.modResults['aps-environment'];
    return c;
  });
};
