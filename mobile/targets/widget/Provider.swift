import SwiftUI
import WidgetKit

/// One TimelineProvider for all three widget sizes. The RN app calls
/// `WidgetCenter.reloadAllTimelines()` after every successful sync,
/// so we don't need a rich timeline — we surface whatever is
/// currently in the App Group container and let the next reload
/// bring fresh data.
///
/// The 15-minute `.after(...)` policy is a safety net for the case
/// where the user hasn't opened the app in a while and the sync hook
/// never fired. iOS may stretch that interval to save battery, which
/// is fine — the staleness is shown in the widget footer.
struct WidgetEntry: TimelineEntry {
  let date: Date
  let snapshot: WidgetSnapshot
}

struct Provider: TimelineProvider {
  func placeholder(in context: Context) -> WidgetEntry {
    WidgetEntry(date: Date(), snapshot: .placeholder)
  }

  func getSnapshot(in context: Context, completion: @escaping (WidgetEntry) -> Void) {
    let entry = WidgetEntry(
      date: Date(),
      snapshot: WidgetSnapshot.read() ?? .placeholder
    )
    completion(entry)
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<WidgetEntry>) -> Void) {
    let entry = WidgetEntry(
      date: Date(),
      snapshot: WidgetSnapshot.read() ?? .placeholder
    )
    let nextReload = Date().addingTimeInterval(15 * 60)
    completion(Timeline(entries: [entry], policy: .after(nextReload)))
  }
}
