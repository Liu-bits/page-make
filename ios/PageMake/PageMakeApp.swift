import SwiftUI

@main
struct PageMakeApp: App {
    @StateObject private var appState = AppState()
    @AppStorage("appearance_mode") private var appearanceRaw = AppearanceMode.system.rawValue

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
                .tint(PageMakeTheme.coral)
                .preferredColorScheme(
                    AppearanceMode(rawValue: appearanceRaw)?.colorScheme
                )
        }
    }
}
