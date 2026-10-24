import SwiftUI

/// 设置页：账号、用量、工具与合规入口。
/// 视觉上沿用项目工作台的纸张/墨蓝体系，不再使用默认 List 样式。
struct SettingsView: View {
    @EnvironmentObject private var appState: AppState
    @AppStorage("appearance_mode") private var appearanceRaw = AppearanceMode.system.rawValue
    @State private var alertItem: AlertItem?
    @State private var showFeedback = false
    @State private var showDocument: AppDocument?
    @State private var showVIPLogin = false
    @State private var showDeleteAccountConfirm = false
    @State private var isDeletingAccount = false

    var body: some View {
        ZStack {
            PageMakeBackground()
            ScrollView {
                VStack(spacing: 16) {
                    profileCard
                    if appState.isLoggedIn {
                        usageCard
                    } else {
                        signInCard
                    }
                    appearanceCard
                    toolsCard
                    aboutCard
                    accountActions
                    WorkspaceBottomSpacer()
                }
                .padding(.horizontal, 16)
                .padding(.top, 10)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .task {
            if appState.isLoggedIn {
                await appState.loadStats()
            }
        }
        .sheet(isPresented: $showFeedback) {
            FeedbackView()
        }
        .sheet(item: $showDocument) { document in
            DocumentView(document: document)
        }
        .sheet(isPresented: $showVIPLogin) {
            VIPLoginView()
                .environmentObject(appState)
        }
        .confirmationDialog(
            L10n.string("delete_account_confirm_title"),
            isPresented: $showDeleteAccountConfirm,
            titleVisibility: .visible
        ) {
            Button(L10n.string("delete_account_button"), role: .destructive) {
                Task { await deleteAccount() }
            }
            Button(L10n.string("cancel"), role: .cancel) {}
        } message: {
            Text(L10n.string("delete_account_confirm_message"))
        }
        .alert(item: $alertItem) { item in
            Alert(
                title: Text(L10n.string(item.titleKey)),
                message: Text(item.message),
                dismissButton: .default(Text(L10n.string("done")))
            )
        }
    }

    // MARK: - 账号

    private var profileCard: some View {
        HStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(.white.opacity(0.1))
                Circle()
                    .stroke(.white.opacity(0.16), lineWidth: 1)
                    .padding(5)
                Image(systemName: appState.isLoggedIn ? "person.fill" : "person.crop.circle")
                    .font(.system(size: 27, weight: .medium))
                    .foregroundStyle(.white)
            }
            .frame(width: 64, height: 64)

            VStack(alignment: .leading, spacing: 5) {
                Text(appState.isLoggedIn ? L10n.string("account_signed_in") : L10n.string("account_guest"))
                    .font(.system(.title3, design: .serif, weight: .bold))
                    .foregroundStyle(.white)
                Text(accountDetail)
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.65))
                    .lineLimit(1)
                if appState.isLoggedIn {
                    Label(L10n.string("account_protected"), systemImage: "checkmark.shield.fill")
                        .font(.caption2.bold())
                        .foregroundStyle(Color(red: 0.63, green: 0.91, blue: 0.82))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(18)
        .background(PageMakeTheme.heroGradient, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(alignment: .topTrailing) {
            Image(systemName: "circle.hexagongrid.fill")
                .font(.system(size: 74))
                .foregroundStyle(.white.opacity(0.055))
                .offset(x: 20, y: -18)
        }
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .shadow(color: PageMakeTheme.ink.opacity(0.16), radius: 20, y: 10)
    }

    private var accountDetail: String {
        guard appState.isLoggedIn else {
            return L10n.string("account_signed_out_hint")
        }
        if let email = appState.session?.email, !email.isEmpty {
            return email
        }
        if let userId = appState.session?.userId {
            return userId.hasPrefix("guest_")
                ? L10n.string("account_guest_detail")
                : userId
        }
        return L10n.string("account_signed_in")
    }

    // MARK: - 用量

    private var appearanceCard: some View {
        PageMakeCard {
            VStack(alignment: .leading, spacing: 15) {
                sectionHeading(
                    icon: "circle.lefthalf.filled",
                    title: L10n.string("appearance_section"),
                    subtitle: L10n.string("appearance_hint"),
                    tint: PageMakeTheme.coral
                )

                HStack(spacing: 7) {
                    ForEach(AppearanceMode.allCases) { mode in
                        appearanceButton(mode)
                    }
                }
            }
        }
    }

    private func appearanceButton(_ mode: AppearanceMode) -> some View {
        let isSelected = appearanceRaw == mode.rawValue
        return Button {
            withAnimation(.easeInOut(duration: 0.22)) {
                appearanceRaw = mode.rawValue
            }
        } label: {
            VStack(spacing: 7) {
                Image(systemName: mode.icon)
                    .font(.system(size: 17, weight: .semibold))
                    .frame(height: 21)
                Text(L10n.string(mode.titleKey))
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 11)
            .background(
                isSelected ? PageMakeTheme.ink : PageMakeTheme.surfaceSoft,
                in: RoundedRectangle(cornerRadius: 13, style: .continuous)
            )
            .foregroundStyle(isSelected ? PageMakeTheme.paper : PageMakeTheme.inkSoft)
            .overlay {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke(isSelected ? Color.clear : PageMakeTheme.border, lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var usageCard: some View {
        PageMakeCard {
            VStack(alignment: .leading, spacing: 15) {
                sectionHeading(
                    icon: "chart.bar.fill",
                    title: L10n.string("stats_section"),
                    subtitle: L10n.string("stats_section_hint"),
                    tint: PageMakeTheme.sea
                )

                HStack(spacing: 8) {
                    metricTile(
                        value: "\(appState.stats?.projectCount ?? appState.projects.count)",
                        label: L10n.string("stats_projects"),
                        tint: PageMakeTheme.coral
                    )
                    metricTile(
                        value: "\(appState.stats?.fileCount ?? appState.projects.reduce(0) { $0 + $1.fileCount })",
                        label: L10n.string("stats_files"),
                        tint: PageMakeTheme.sea
                    )
                    metricTile(
                        value: formatBytes(appState.stats?.totalSize ?? Int(appState.projects.reduce(Int64(0)) { $0 + $1.size })),
                        label: L10n.string("stats_size"),
                        tint: PageMakeTheme.gold
                    )
                }
            }
        }
    }

    private func metricTile(value: String, label: String, tint: Color) -> some View {
        VStack(spacing: 5) {
            Text(value)
                .font(.system(.headline, design: .rounded, weight: .bold))
                .foregroundStyle(PageMakeTheme.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(label)
                .font(.caption2)
                .foregroundStyle(PageMakeTheme.inkSoft)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(tint.opacity(0.085), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(alignment: .bottom) {
            Capsule()
                .fill(tint.opacity(0.65))
                .frame(width: 18, height: 2)
                .padding(.bottom, 6)
        }
    }

    private var signInCard: some View {
        PageMakeCard {
            VStack(alignment: .leading, spacing: 13) {
                sectionHeading(
                    icon: "person.badge.key.fill",
                    title: L10n.string("account_section"),
                    subtitle: L10n.string("account_signed_out_hint"),
                    tint: PageMakeTheme.coral
                )

                Button {
                    Task { await appState.signIn() }
                } label: {
                    Label(L10n.string("login_apple"), systemImage: "apple.logo")
                }
                .buttonStyle(PrimaryButtonStyle())

                Button {
                    Task {
                        if let error = await appState.signInWithGoogle() {
                            alertItem = AlertItem(message: error)
                        }
                    }
                } label: {
                    Label(L10n.string("login_google"), systemImage: "g.circle.fill")
                }
                .buttonStyle(SecondaryButtonStyle())

                Button {
                    showVIPLogin = true
                } label: {
                    Label(L10n.string("vip_login"), systemImage: "crown.fill")
                }
                .buttonStyle(SecondaryButtonStyle())

                Button {
                    Task { await appState.signInAsGuest() }
                } label: {
                    Label(L10n.string("login_guest"), systemImage: "person.fill")
                }
                .buttonStyle(SecondaryButtonStyle())
            }
        }
    }

    // MARK: - 工具

    private var toolsCard: some View {
        PageMakeCard {
            VStack(alignment: .leading, spacing: 0) {
                sectionHeading(
                    icon: "wrench.and.screwdriver.fill",
                    title: L10n.string("tools_section"),
                    subtitle: L10n.string("tools_section_hint"),
                    tint: PageMakeTheme.gold
                )
                .padding(.bottom, 6)

                if let exportURL = LogStore.shared.export() {
                    ShareLink(item: exportURL) {
                        settingsRowContent(
                            icon: "square.and.arrow.up",
                            title: L10n.string("export_logs"),
                            tint: PageMakeTheme.sea
                        )
                    }
                    .buttonStyle(.plain)
                    divider
                }

                Button {
                    showFeedback = true
                } label: {
                    settingsRowContent(
                        icon: "bubble.left.and.bubble.right.fill",
                        title: L10n.string("feedback"),
                        tint: PageMakeTheme.coral
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - 关于

    private var aboutCard: some View {
        PageMakeCard {
            VStack(alignment: .leading, spacing: 0) {
                sectionHeading(
                    icon: "doc.text.fill",
                    title: L10n.string("about_section"),
                    subtitle: L10n.string("about_section_hint"),
                    tint: PageMakeTheme.inkSoft
                )
                .padding(.bottom, 6)

                Button {
                    showDocument = .privacyPolicy
                } label: {
                    settingsRowContent(
                        icon: "hand.raised.fill",
                        title: L10n.string("privacy_policy"),
                        tint: PageMakeTheme.sea
                    )
                }
                .buttonStyle(.plain)

                divider

                Button {
                    showDocument = .userAgreement
                } label: {
                    settingsRowContent(
                        icon: "checkmark.seal.fill",
                        title: L10n.string("user_agreement"),
                        tint: PageMakeTheme.gold
                    )
                }
                .buttonStyle(.plain)

                divider

                HStack {
                    Text(L10n.string("version_label"))
                        .font(.subheadline)
                        .foregroundStyle(PageMakeTheme.inkSoft)
                    Spacer()
                    Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0")
                        .font(.system(.subheadline, design: .monospaced, weight: .semibold))
                        .foregroundStyle(PageMakeTheme.ink)
                }
                .padding(.vertical, 12)
            }
        }
    }

    // MARK: - 账号操作

    @ViewBuilder
    private var accountActions: some View {
        if appState.isLoggedIn {
            VStack(spacing: 10) {
                if let session = appState.session, session.userId.hasPrefix("guest_") {
                    Label(L10n.string("guest_signout_hint"), systemImage: "info.circle")
                        .font(.caption)
                        .foregroundStyle(PageMakeTheme.inkSoft)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                }

                Button {
                    appState.signOut()
                } label: {
                    Label(L10n.string("sign_out"), systemImage: "rectangle.portrait.and.arrow.right")
                        .font(.system(.subheadline, design: .rounded, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                        .background(PageMakeTheme.surface, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                        .foregroundStyle(PageMakeTheme.ink)
                }
                .buttonStyle(.plain)

                Button(role: .destructive) {
                    showDeleteAccountConfirm = true
                } label: {
                    HStack {
                        if isDeletingAccount {
                            ProgressView()
                                .tint(PageMakeTheme.coral)
                        } else {
                            Image(systemName: "trash")
                        }
                        Text(L10n.string("delete_account"))
                    }
                    .font(.system(.subheadline, design: .rounded, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .foregroundStyle(PageMakeTheme.coral)
                    .background(PageMakeTheme.coral.opacity(0.07), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 15, style: .continuous)
                            .stroke(PageMakeTheme.coral.opacity(0.17), lineWidth: 1)
                    }
                }
                .buttonStyle(.plain)
                .disabled(isDeletingAccount)
            }
        }
    }

    // MARK: - 公共组件

    private func sectionHeading(icon: String, title: String, subtitle: String, tint: Color) -> some View {
        HStack(spacing: 11) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 31, height: 31)
                .background(tint.opacity(0.11), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(.subheadline, design: .rounded, weight: .bold))
                    .foregroundStyle(PageMakeTheme.ink)
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(PageMakeTheme.inkSoft)
            }
        }
    }

    private func settingsRowContent(icon: String, title: String, tint: Color) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 29, height: 29)
                .background(tint.opacity(0.09), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            Text(title)
                .font(.subheadline)
                .foregroundStyle(PageMakeTheme.ink)
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption2.bold())
                .foregroundStyle(PageMakeTheme.inkSoft.opacity(0.4))
        }
        .frame(maxWidth: .infinity, minHeight: 46)
        .contentShape(Rectangle())
    }

    private var divider: some View {
        Rectangle()
            .fill(PageMakeTheme.ink.opacity(0.055))
            .frame(height: 1)
            .padding(.leading, 41)
    }

    private func formatBytes(_ bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB, .useGB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }

    private func deleteAccount() async {
        isDeletingAccount = true
        defer { isDeletingAccount = false }
        if let error = await appState.deleteAccount() {
            alertItem = AlertItem(message: error)
        }
    }
}
