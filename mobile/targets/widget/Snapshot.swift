import Foundation

/// Mirrors `WidgetSnapshot` in mobile/src/widget/snapshot.ts.
///
/// When you add a field on the TypeScript side, add it here too — the
/// `JSONDecoder` will silently skip unknown keys (no crash), but the
/// new field won't appear in the widget UI until both sides agree on
/// the shape.
struct WidgetSnapshot: Codable {
  let updatedAt: String
  let netCashMtd: NetCash
  let cashAccounts: [CashAccount]
  let totalCash: Double

  struct NetCash: Codable {
    let income: Double
    let spending: Double
    let net: Double
    let transactionCount: Int
  }

  struct CashAccount: Codable, Identifiable {
    let id: Int
    let displayName: String
    let institutionName: String?
    let mask: String?
    let balance: Double
  }
}

extension WidgetSnapshot {
  /// Shared App Group identifier. Must match
  /// `mobile/modules/widget-bridge/ios/WidgetBridgeModule.swift`
  /// and `app.json` ios.entitlements.
  static let appGroup = "group.com.tuskledger.mobile"
  static let snapshotKey = "snapshot"

  /// Read the latest snapshot from the shared App Group container.
  /// Returns nil if the app hasn't run a sync yet or the entitlement
  /// is misconfigured (suite name returns nil).
  static func read() -> WidgetSnapshot? {
    guard
      let defaults = UserDefaults(suiteName: Self.appGroup),
      let json = defaults.string(forKey: Self.snapshotKey),
      let data = json.data(using: .utf8)
    else { return nil }
    return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
  }

  /// Used by the widget gallery and on cold-start before any sync has
  /// landed. Numbers are recognizable-but-fake so it's obviously a
  /// preview, not real data.
  static let placeholder = WidgetSnapshot(
    updatedAt: ISO8601DateFormatter().string(from: Date()),
    netCashMtd: .init(income: 5200, spending: 3400, net: 1800, transactionCount: 142),
    cashAccounts: [
      .init(id: 1, displayName: "Chase Checking",    institutionName: "Chase",       mask: "1234", balance: 8421.18),
      .init(id: 2, displayName: "Ally Savings",      institutionName: "Ally Bank",   mask: "9876", balance: 4302.07),
      .init(id: 3, displayName: "Cash Reserve",      institutionName: "Wealthfront", mask: "5544", balance: 1011.55),
    ],
    totalCash: 13734.80
  )
}
