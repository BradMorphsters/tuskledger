import SwiftUI
import WidgetKit

/// Widget bundle entry point. Hosts a single widget for now
/// (`TuskLedgerWidget`). Future ambient surfaces — Lock Screen
/// accessory, Live Activity — would slot in alongside it here.
@main
struct TuskLedgerWidgets: WidgetBundle {
  var body: some Widget {
    TuskLedgerWidget()
  }
}

/// Home-screen widget: cash account balances + month-to-date net cash.
/// All three home-screen sizes are supported. Data comes from the
/// shared App Group container; see Snapshot.swift for the read path
/// and Provider.swift for the timeline policy.
struct TuskLedgerWidget: Widget {
  let kind: String = "TuskLedgerWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: Provider()) { entry in
      WidgetEntryView(entry: entry)
        .containerBackground(for: .widget) {
          Color("WidgetBackground")
        }
    }
    .configurationDisplayName("Tusk Ledger")
    .description("Cash balances and this month's net cash, synced from your laptop.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}
