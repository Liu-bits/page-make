import SwiftUI

/// 设置页：账号、用量、工具与合规入口。
/// 视觉上沿用项目工作台的纸张/墨蓝体系，不再使用默认 List 样式。
struct SettingsView: View {
    @EnvironmentObject private var appState: AppState
    @AppStorage("appearance_mode") private var appearanceRaw = AppearanceMode.system.rawValue
    @State private var alertItem: AlertItem?
    @State private var showFeedback = false
    @State private var showDocument: AppDocument?
    @State private var showDeleteAccountConfirm = false
    @State private var isDeletingAccount = false
    @State private var showVIPApplication = false
    @State private var isRefreshingVIPRequest = false

    var body: some View {
        ZStack {
            PageMakeBackground()
            ScrollView {
                VStack(spacing: 16) {
                    profileCard
                    if appState.isLoggedIn {
                        if currentTier != .ultra {
                            vipUpgradeCard
                        }
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
        .sheet(isPresented: $showVIPApplication) {
            VIPUpgradeApplicationView(tier: currentTier, nextTier: nextTier)
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
                    .fill(Theme.elevatedBackground)
                Circle()
                    .stroke(Theme.separator.opacity(0.55), lineWidth: 1)
                    .padding(5)
                Image(systemName: appState.isLoggedIn ? "person.fill" : "person.crop.circle")
                    .font(.system(size: 27, weight: .medium))
                    .foregroundStyle(Theme.label)
            }
            .frame(width: 64, height: 64)

            VStack(alignment: .leading, spacing: 5) {
                Text(appState.isLoggedIn ? L10n.string("account_signed_in") : L10n.string("account_guest"))
                    .font(.system(.title3, weight: .bold))
                    .foregroundStyle(Theme.label)
                Text(accountDetail)
                    .font(.footnote)
                    .foregroundStyle(Theme.secondaryLabel)
                    .lineLimit(1)
                if let role = appState.session?.role, role != .user {
                    Text(L10n.string(currentTier.titleKey))
                        .font(.system(size: 10, weight: .bold))
                        .textCase(.uppercase)
                        .tracking(0.6)
                        .foregroundStyle(Theme.premium)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Theme.premium.opacity(0.13), in: Capsule())
                }
                if appState.isLoggedIn {
                    Label(L10n.string("account_protected"), systemImage: "checkmark.shield.fill")
                        .font(.caption2.bold())
                        .foregroundStyle(Theme.positive)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(Theme.cardPadding)
        .glassPanel(tint: Theme.cardTint, radius: Theme.cardRadius)
    }

    private var accountDetail: String {
        guard appState.isLoggedIn else {
            return L10n.string("account_signed_out_hint")
        }
        if let email = appState.session?.email, !email.isEmpty {
            return email
        }
        if let session = appState.session {
            switch session.role {
            case .vip:
                return L10n.string(session.accountKind == .guestVip
                    ? "account_guest_vip_detail"
                    : "account_vip_detail")
            case .svip, .ultra:
                return L10n.format("account_paid_tier_detail", L10n.string(session.role.titleKey))
            case .user:
                break
            }
            if session.accountKind == .guest {
                return L10n.string("account_guest_detail")
            }
            return session.userId
        }
        return L10n.string("account_signed_in")
    }

    // MARK: - 等级与升级

    /// 当前等级：服务端 `GET /api/vip-request` 快照优先，其次本地会话角色。
    private var currentTier: AccountRole {
        appState.vipUpgradeStatus?.tier ?? appState.session?.role ?? .user
    }

    /// 下一档：服务端 nextTier 优先；Ultra 为 nil（整张卡不显示）。
    /// 注意要区分「服务端明确返回 null（已到顶）」与「快照还没加载」：
    /// 用 `??` 会把两者混成一种，服务端说 Ultra 时又退回本地推算。
    private var nextTier: AccountRole? {
        if let status = appState.vipUpgradeStatus {
            return status.nextTier
        }
        return currentTier.nextTier
    }

    /// 服务端是否允许申请（游客限制、审核中等情况由后端判定）。
    private var canApplyUpgrade: Bool {
        appState.vipUpgradeStatus?.canApply ?? (nextTier != nil)
    }

    private var upgradeTitle: String {
        guard let nextTier else { return L10n.string("tier_ultra") }
        switch nextTier {
        // .user 只会在服务端下发了异常的 nextTier 时出现（正常链路 user 的下一档是 vip）；
        // 兜底用「升级 VIP」文案，不要留空分支让 switch 不穷尽。
        case .user: return L10n.string("vip_upgrade_title")
        case .vip: return L10n.string("vip_upgrade_title")
        case .svip: return L10n.string("upgrade_to_svip_title")
        case .ultra: return L10n.string("upgrade_to_ultra_title")
        }
    }

    private var vipUpgradeCard: some View {
        PageMakeCard(tint: Theme.premiumTint) {
            VStack(alignment: .leading, spacing: 12) {
                sectionHeading(
                    icon: "crown.fill",
                    title: upgradeTitle,
                    subtitle: L10n.string("vip_upgrade_subtitle"),
                    tint: Theme.premium
                )

                // 等级一览：当前 → 下一档（只能申请下一级）
                HStack(spacing: 8) {
                    tierChip(
                        title: L10n.string("vip_current_tier"),
                        value: L10n.string(currentTier.titleKey),
                        tint: Theme.secondaryLabel
                    )
                    if let nextTier {
                        Image(systemName: "arrow.right")
                            .font(.caption2.bold())
                            .foregroundStyle(Theme.tertiaryLabel)
                        tierChip(
                            title: L10n.string("vip_next_tier"),
                            value: L10n.string(nextTier.titleKey),
                            tint: Theme.premium
                        )
                    }
                }

                if let request = appState.vipUpgradeRequest {
                    Label(vipRequestStatusText(request), systemImage: vipRequestStatusIcon(request))
                        .font(.caption.bold())
                        .foregroundStyle(vipRequestStatusColor(request))
                    if request.status == .pending, let requested = request.requestedTier {
                        Text(L10n.format("vip_request_pending_tier_short", L10n.string(requested.titleKey)))
                            .font(.caption2)
                            .foregroundStyle(Theme.secondaryLabel)
                    }
                }

                if let nextTier {
                    Button {
                        showVIPApplication = true
                    } label: {
                        Label(
                            appState.vipUpgradeRequest?.status == .pending
                                ? L10n.string("vip_request_view")
                                : L10n.format("vip_request_upgrade_to", L10n.string(nextTier.titleKey)),
                            systemImage: "arrow.up.right.circle.fill"
                        )
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    // pending 时始终可进入查看进度；未申请时由服务端 canApply 决定
                    .disabled(appState.vipUpgradeRequest == nil && !canApplyUpgrade)

                    if appState.vipUpgradeRequest == nil && !canApplyUpgrade {
                        Text(L10n.string("vip_request_not_available"))
                            .font(.caption2)
                            .foregroundStyle(Theme.secondaryLabel)
                    }
                }

                // 审核是后台人工处理的，App 不会收到推送；批准后必须主动拉一次
                // 角色快照，否则用户看不到「已升级」，项目数/链接限制也不会解除。
                Button {
                    Task { await refreshVIPRequest() }
                } label: {
                    if isRefreshingVIPRequest {
                        ProgressView().tint(Theme.secondaryLabel)
                    } else {
                        Label(L10n.string("vip_request_refresh"), systemImage: "arrow.clockwise")
                            .font(.system(.caption, weight: .semibold))
                            .foregroundStyle(Theme.secondaryLabel)
                    }
                }
                .buttonStyle(.plain)
                .disabled(isRefreshingVIPRequest)
            }
        }
    }

    private func tierChip(title: String, value: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(Theme.tertiaryLabel)
            Text(value)
                .font(.system(.caption, weight: .bold))
                .foregroundStyle(tint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .glassPanel(radius: 12)
    }

    /// 拉取最新角色与申请状态：管理员批准后用户点一下即可立刻拿到 VIP 权益。
    private func refreshVIPRequest() async {
        isRefreshingVIPRequest = true
        defer { isRefreshingVIPRequest = false }
        await appState.refreshAccountRole()
    }

    private func vipRequestStatusText(_ request: VIPUpgradeRequest) -> String {
        switch request.status {
        case .pending:
            return L10n.string("vip_request_pending")
        case .approved:
            return L10n.string("vip_request_approved")
        case .rejected:
            return request.reviewNote.isEmpty
                ? L10n.string("vip_request_rejected")
                : L10n.format("vip_request_rejected_reason", request.reviewNote)
        }
    }

    private func vipRequestStatusIcon(_ request: VIPUpgradeRequest) -> String {
        switch request.status {
        case .pending: return "clock.fill"
        case .approved: return "checkmark.seal.fill"
        case .rejected: return "xmark.circle.fill"
        }
    }

    private func vipRequestStatusColor(_ request: VIPUpgradeRequest) -> Color {
        switch request.status {
        case .pending: return Theme.premium
        case .approved: return Theme.positive
        case .rejected: return Theme.highlight
        }
    }

    private var appearanceCard: some View {
        PageMakeCard {
            VStack(alignment: .leading, spacing: 15) {
                sectionHeading(
                    icon: "circle.lefthalf.filled",
                    title: L10n.string("appearance_section"),
                    subtitle: L10n.string("appearance_hint"),
                    tint: Theme.highlight
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
                    .font(.system(size: 11, weight: .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 11)
            .background(
                isSelected ? Theme.label : Theme.elevatedBackground,
                in: RoundedRectangle(cornerRadius: 13, style: .continuous)
            )
            .foregroundStyle(isSelected ? Theme.background : Theme.secondaryLabel)
            .overlay {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke(isSelected ? Color.clear : Theme.separator, lineWidth: 1)
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
                    tint: Theme.positive
                )

                HStack(spacing: 8) {
                    metricTile(
                        value: "\(appState.stats?.projectCount ?? appState.projects.count)",
                        label: L10n.string("stats_projects"),
                        tint: Theme.highlight
                    )
                    metricTile(
                        value: "\(appState.stats?.fileCount ?? appState.projects.reduce(0) { $0 + $1.fileCount })",
                        label: L10n.string("stats_files"),
                        tint: Theme.positive
                    )
                    metricTile(
                        value: formatBytes(appState.stats?.totalSize ?? Int(appState.projects.reduce(Int64(0)) { $0 + $1.size })),
                        label: L10n.string("stats_size"),
                        tint: Theme.premium
                    )
                }

                if let session = appState.session {
                    Divider()
                        .overlay(Theme.label.opacity(0.06))
                    HStack(spacing: 8) {
                        Label(L10n.format("quota_summary", quotaLabel(session)), systemImage: "externaldrive.fill")
                            .font(.caption)
                            .foregroundStyle(Theme.secondaryLabel)
                        Spacer(minLength: 0)
                        Text(L10n.string(session.role.titleKey))
                            .font(.caption2.bold())
                            .foregroundStyle(Theme.premium)
                    }
                }
            }
        }
    }

    private func metricTile(value: String, label: String, tint: Color) -> some View {
        VStack(spacing: 5) {
            Text(value)
                .font(.system(.headline, weight: .bold))
                .foregroundStyle(Theme.label)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(label)
                .font(.caption2)
                .foregroundStyle(Theme.secondaryLabel)
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
                    tint: Theme.highlight
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
                    tint: Theme.premium
                )
                .padding(.bottom, 6)

                if let exportURL = LogStore.shared.export() {
                    ShareLink(item: exportURL) {
                        settingsRowContent(
                            icon: "square.and.arrow.up",
                            title: L10n.string("export_logs"),
                            tint: Theme.positive
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
                        tint: Theme.highlight
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
                    tint: Theme.secondaryLabel
                )
                .padding(.bottom, 6)

                Button {
                    showDocument = .privacyPolicy
                } label: {
                    settingsRowContent(
                        icon: "hand.raised.fill",
                        title: L10n.string("privacy_policy"),
                        tint: Theme.positive
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
                        tint: Theme.premium
                    )
                }
                .buttonStyle(.plain)

                divider

                HStack {
                    Text(L10n.string("version_label"))
                        .font(.subheadline)
                        .foregroundStyle(Theme.secondaryLabel)
                    Spacer()
                    Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0")
                        .font(.system(.subheadline, design: .monospaced, weight: .semibold))
                        .foregroundStyle(Theme.label)
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
                if let session = appState.session, session.isGuestLimited {
                    Label(L10n.string("guest_signout_hint"), systemImage: "info.circle")
                        .font(.caption)
                        .foregroundStyle(Theme.secondaryLabel)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                }
                if let session = appState.session, session.isVIP {
                    let hint = session.role == .vip
                        ? L10n.string("vip_active_hint")
                        : L10n.format("tier_active_hint", L10n.string(session.role.titleKey))
                    Label(hint, systemImage: "crown.fill")
                        .font(.caption)
                        .foregroundStyle(Theme.premium)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                }

                Button {
                    appState.signOut()
                } label: {
                    Label(L10n.string("sign_out"), systemImage: "rectangle.portrait.and.arrow.right")
                        .font(.system(.subheadline, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                        .background(Theme.elevatedBackground, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                        .foregroundStyle(Theme.label)
                }
                .buttonStyle(.plain)

                Button(role: .destructive) {
                    showDeleteAccountConfirm = true
                } label: {
                    HStack {
                        if isDeletingAccount {
                            ProgressView()
                                .tint(Theme.highlight)
                        } else {
                            Image(systemName: "trash")
                        }
                        Text(L10n.string("delete_account"))
                    }
                    .font(.system(.subheadline, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .foregroundStyle(Theme.highlight)
                    .background(Theme.highlight.opacity(0.07), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 15, style: .continuous)
                            .stroke(Theme.highlight.opacity(0.17), lineWidth: 1)
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
                    .font(.system(.subheadline, weight: .bold))
                    .foregroundStyle(Theme.label)
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(Theme.secondaryLabel)
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
                .foregroundStyle(Theme.label)
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption2.bold())
                .foregroundStyle(Theme.secondaryLabel.opacity(0.4))
        }
        .frame(maxWidth: .infinity, minHeight: 46)
        .contentShape(Rectangle())
    }

    private var divider: some View {
        Rectangle()
            .fill(Theme.label.opacity(0.055))
            .frame(height: 1)
            .padding(.leading, 41)
    }

    private func formatBytes(_ bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB, .useGB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }

    private func quotaLabel(_ session: UserSession) -> String {
        guard let limit = session.staticProjectLimit else {
            return L10n.string("quota_unlimited")
        }
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useMB, .useGB]
        formatter.countStyle = .file
        formatter.allowsNonnumericFormatting = false
        return formatter.string(fromByteCount: limit)
    }

    private func deleteAccount() async {
        isDeletingAccount = true
        defer { isDeletingAccount = false }
        if let error = await appState.deleteAccount() {
            alertItem = AlertItem(message: error)
        }
    }
}
