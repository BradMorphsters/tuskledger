/**
 * @bacons/apple-targets config for the Tusk Ledger home-screen widget.
 *
 * - `type: 'widget'` adds an iOS Widget Extension target during
 *   `expo prebuild` / EAS build. The Swift sources next to this file
 *   are copied into the target verbatim.
 *
 * - The App Group identifier MUST match what the main app declares in
 *   `app.json` (ios.entitlements) and what the `widget-bridge` module
 *   writes to. Mismatch = the widget reads nil and shows the
 *   placeholder forever.
 *
 * - The widget's bundle identifier is derived from the main app's
 *   bundle id (`com.tuskledger.mobile`) by appending `.widget`.
 *   iOS requires the widget extension's bundle id to be a child of
 *   the host app's.
 */
module.exports = {
  type: 'widget',
  name: 'TuskLedgerWidget',
  icon: '../../assets/icon.png',
  colors: {
    $accent: '#7AB6FF',
    WidgetBackground: '#0e0f12',
  },
  entitlements: {
    'com.apple.security.application-groups': [
      'group.com.tuskledger.mobile',
    ],
  },
  deploymentTarget: '17.0',
};
