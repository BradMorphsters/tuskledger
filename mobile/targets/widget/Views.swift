import SwiftUI
import WidgetKit

/// Top-level dispatch — picks the right layout for the current
/// `widgetFamily`. The three home-screen sizes have different
/// information densities by design:
///
///   Small  — single glance: total cash + net MTD
///   Medium — total cash + MTD breakdown + top 3 accounts
///   Large  — full MTD card + all cash accounts (up to 7)
struct WidgetEntryView: View {
  @Environment(\.widgetFamily) var family
  let entry: WidgetEntry

  var body: some View {
    switch family {
    case .systemSmall:  SmallView(snapshot: entry.snapshot)
    case .systemMedium: MediumView(snapshot: entry.snapshot)
    case .systemLarge:  LargeView(snapshot: entry.snapshot)
    default:            SmallView(snapshot: entry.snapshot)
    }
  }
}

// MARK: - Shared style

private let incomeColor  = Color(red: 0.45, green: 0.78, blue: 0.51)
private let expenseColor = Color(red: 0.91, green: 0.43, blue: 0.43)
private let mutedColor   = Color.white.opacity(0.55)
private let faintColor   = Color.white.opacity(0.32)

private func money(_ v: Double) -> String {
  let f = NumberFormatter()
  f.numberStyle = .currency
  f.currencyCode = "USD"
  f.maximumFractionDigits = 0
  return f.string(from: NSNumber(value: v)) ?? "$\(Int(v))"
}

private func moneyCents(_ v: Double) -> String {
  let f = NumberFormatter()
  f.numberStyle = .currency
  f.currencyCode = "USD"
  f.maximumFractionDigits = 2
  return f.string(from: NSNumber(value: v)) ?? "$\(v)"
}

private func netColor(_ net: Double) -> Color {
  net >= 0 ? incomeColor : expenseColor
}

private func monthShort() -> String {
  let f = DateFormatter()
  f.dateFormat = "MMM"
  return f.string(from: Date()).uppercased()
}

private func relativeSynced(_ iso: String) -> String {
  // Try the formatter that matches what JS produces (with fractional
  // seconds). Fall back to the lenient one for older builds.
  let parser = ISO8601DateFormatter()
  parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  let date = parser.date(from: iso)
    ?? ISO8601DateFormatter().date(from: iso)
    ?? Date()
  let f = RelativeDateTimeFormatter()
  f.unitsStyle = .short
  return f.localizedString(for: date, relativeTo: Date())
}

// MARK: - Small

struct SmallView: View {
  let snapshot: WidgetSnapshot

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("TOTAL CASH")
        .font(.system(size: 9, weight: .semibold))
        .tracking(0.6)
        .foregroundColor(mutedColor)
      Text(money(snapshot.totalCash))
        .font(.system(size: 22, weight: .bold, design: .rounded))
        .foregroundColor(.white)
        .minimumScaleFactor(0.6)
        .lineLimit(1)

      Divider().background(faintColor.opacity(0.6))
        .padding(.vertical, 2)

      Text("NET · \(monthShort())")
        .font(.system(size: 9, weight: .semibold))
        .tracking(0.6)
        .foregroundColor(mutedColor)
      Text(signed(snapshot.netCashMtd.net))
        .font(.system(size: 18, weight: .bold, design: .rounded))
        .foregroundColor(netColor(snapshot.netCashMtd.net))
        .minimumScaleFactor(0.6)
        .lineLimit(1)

      Spacer(minLength: 0)
      Text("Synced \(relativeSynced(snapshot.updatedAt))")
        .font(.system(size: 8))
        .foregroundColor(faintColor)
    }
  }
}

// MARK: - Medium

struct MediumView: View {
  let snapshot: WidgetSnapshot

  var body: some View {
    HStack(alignment: .top, spacing: 14) {
      // Left: net MTD with income/spending breakdown
      VStack(alignment: .leading, spacing: 4) {
        Text("\(monthShort()) NET CASH")
          .font(.system(size: 9, weight: .semibold))
          .tracking(0.6)
          .foregroundColor(mutedColor)
        Text(signed(snapshot.netCashMtd.net))
          .font(.system(size: 24, weight: .bold, design: .rounded))
          .foregroundColor(netColor(snapshot.netCashMtd.net))
          .minimumScaleFactor(0.6)
          .lineLimit(1)
        HStack(spacing: 10) {
          Label(money(snapshot.netCashMtd.income), systemImage: "arrow.up")
            .font(.system(size: 10))
            .foregroundColor(incomeColor)
          Label(money(snapshot.netCashMtd.spending), systemImage: "arrow.down")
            .font(.system(size: 10))
            .foregroundColor(expenseColor)
        }
        Text("Synced \(relativeSynced(snapshot.updatedAt))")
          .font(.system(size: 9))
          .foregroundColor(faintColor)
        Spacer(minLength: 0)
        Text("Total cash \(money(snapshot.totalCash))")
          .font(.system(size: 10, weight: .medium))
          .foregroundColor(mutedColor)
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      // Right: top 3 cash accounts
      VStack(alignment: .leading, spacing: 6) {
        ForEach(snapshot.cashAccounts.prefix(3)) { acct in
          AccountRowCompact(acct: acct)
        }
        if snapshot.cashAccounts.count > 3 {
          Text("+\(snapshot.cashAccounts.count - 3) more")
            .font(.system(size: 9))
            .foregroundColor(faintColor)
        }
        Spacer(minLength: 0)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

// MARK: - Large

struct LargeView: View {
  let snapshot: WidgetSnapshot

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      // Header: MTD net + breakdown
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text("\(monthShort()) NET CASH")
            .font(.system(size: 9, weight: .semibold))
            .tracking(0.6)
            .foregroundColor(mutedColor)
          Spacer()
          Text("Total cash \(money(snapshot.totalCash))")
            .font(.system(size: 10, weight: .medium))
            .foregroundColor(mutedColor)
        }
        Text(signed(snapshot.netCashMtd.net))
          .font(.system(size: 30, weight: .bold, design: .rounded))
          .foregroundColor(netColor(snapshot.netCashMtd.net))
          .minimumScaleFactor(0.6)
          .lineLimit(1)
        HStack(spacing: 14) {
          Label(money(snapshot.netCashMtd.income), systemImage: "arrow.up")
            .font(.system(size: 11))
            .foregroundColor(incomeColor)
          Label(money(snapshot.netCashMtd.spending), systemImage: "arrow.down")
            .font(.system(size: 11))
            .foregroundColor(expenseColor)
        }
      }

      Divider().background(faintColor.opacity(0.6))

      // Account list — up to 7 rows fits cleanly at the large size
      VStack(alignment: .leading, spacing: 7) {
        ForEach(snapshot.cashAccounts.prefix(7)) { acct in
          AccountRow(acct: acct)
        }
        if snapshot.cashAccounts.count > 7 {
          Text("+\(snapshot.cashAccounts.count - 7) more")
            .font(.system(size: 10))
            .foregroundColor(faintColor)
        }
      }

      Spacer(minLength: 0)

      Text("Synced \(relativeSynced(snapshot.updatedAt))")
        .font(.system(size: 9))
        .foregroundColor(faintColor)
    }
  }
}

// MARK: - Account row helpers

private struct AccountRow: View {
  let acct: WidgetSnapshot.CashAccount
  var body: some View {
    HStack {
      VStack(alignment: .leading, spacing: 1) {
        Text(acct.displayName)
          .font(.system(size: 12, weight: .medium))
          .foregroundColor(.white)
          .lineLimit(1)
        Text(subtitle())
          .font(.system(size: 9))
          .foregroundColor(mutedColor)
          .lineLimit(1)
      }
      Spacer()
      Text(moneyCents(acct.balance))
        .font(.system(size: 12, weight: .semibold, design: .rounded))
        .foregroundColor(.white)
        .monospacedDigit()
    }
  }

  private func subtitle() -> String {
    var parts: [String] = []
    if let inst = acct.institutionName, !inst.isEmpty { parts.append(inst) }
    if let mask = acct.mask, !mask.isEmpty { parts.append("\u{22EF}\(mask)") } // ⋯
    return parts.joined(separator: " · ")
  }
}

private struct AccountRowCompact: View {
  let acct: WidgetSnapshot.CashAccount
  var body: some View {
    HStack {
      Text(acct.displayName)
        .font(.system(size: 11, weight: .medium))
        .foregroundColor(.white)
        .lineLimit(1)
      Spacer()
      Text(money(acct.balance))
        .font(.system(size: 11, weight: .semibold, design: .rounded))
        .foregroundColor(.white)
        .monospacedDigit()
    }
  }
}

// MARK: - misc

private func signed(_ v: Double) -> String {
  (v >= 0 ? "+" : "") + money(v)
}
