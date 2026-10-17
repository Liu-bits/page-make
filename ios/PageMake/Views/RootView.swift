import SwiftUI

/// 根视图：封号拦截 + 主界面 + 创建流程
struct RootView: View {
    @EnvironmentObject private var appState: AppState

    @State private var showFilePicker = false
    @State private var pendingSource: CreateSource?
    @State private var showSettings = false

    var body: some View {
        Group {
            if let ban = appState.banInfo {
                BannedView(ban: ban)
            } else {
                mainContent
            }
        }
        .animation(.default, value: appState.banInfo != nil)
        .sheet(isPresented: $showFilePicker) {
            FilePickerView { source in
                showFilePicker = false
                pendingSource = source
            }
        }
        .sheet(isPresented: Binding(
            get: { pendingSource != nil },
            set: { if !$0 { pendingSource = nil } }
        )) {
            if let source = pendingSource {
                CreateFlowView(source: source)
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .alert(
            L10n.string("alert_error"),
            isPresented: Binding(
                get: { appState.authError != nil },
                set: { if !$0 { appState.authError = nil } }
            )
        ) {
            Button(L10n.string("done"), role: .cancel) {}
        } message: {
            if let message = appState.authError {
                Text(message)
            }
        }
    }

    private var mainContent: some View {
        NavigationStack {
            ProjectListView(showFilePicker: $showFilePicker, showSettings: $showSettings)
        }
    }
}
