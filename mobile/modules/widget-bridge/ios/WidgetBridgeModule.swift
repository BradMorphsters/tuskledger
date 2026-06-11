import ExpoModulesCore
import WidgetKit

/**
 * Bridge between the React Native runtime and the iOS Widget
 * extension. The widget extension runs in its own process and can
 * only see data we explicitly drop into the shared App Group
 * container.
 *
 * Two responsibilities, both fire-and-forget:
 *   1. writeSnapshot(json) — persist the latest snapshot to App Group
 *      UserDefaults under the well-known "snapshot" key.
 *   2. reloadAll() — ask WidgetKit to re-run all timeline providers
 *      so the widget renders against the fresh snapshot immediately.
 *
 * App Group identifier must match the one the widget target declares
 * (mobile/targets/widget/expo-target.config.js) and the one in
 * `app.json`'s ios.entitlements. Mismatch = silent "widget always
 * shows the placeholder" because the suite returns nil.
 */
public class WidgetBridgeModule: Module {
  private static let appGroup = "group.com.tuskledger.mobile"
  private static let snapshotKey = "snapshot"

  public func definition() -> ModuleDefinition {
    Name("WidgetBridge")

    AsyncFunction("writeSnapshot") { (json: String) -> Void in
      guard let defaults = UserDefaults(suiteName: WidgetBridgeModule.appGroup) else {
        throw Exception(
          name: "WidgetBridgeError",
          description: "Could not open App Group UserDefaults for \(WidgetBridgeModule.appGroup). Check the entitlement on the main app target."
        )
      }
      defaults.set(json, forKey: WidgetBridgeModule.snapshotKey)
    }

    AsyncFunction("reloadAll") { () -> Void in
      if #available(iOS 14.0, *) {
        WidgetCenter.shared.reloadAllTimelines()
      }
    }
  }
}
