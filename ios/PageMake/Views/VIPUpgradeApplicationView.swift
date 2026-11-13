import SwiftUI

/// VIP 升级申请：提交后由管理后台审核，不创建邮箱账号或密码。
///
/// 契约（后端 `GET/POST /api/vip-request`）：
/// - 只能申请**下一档**：user → VIP → SVIP → Ultra；Ultra 已到顶，入口整体隐藏。
/// - 等级与可申请性以服务端下发的 `tier / nextTier / canApply` 为准，
///   客户端不再自己猜「游客才能申请」。
struct VIPUpgradeApplicationView: View {
    /// 当前等级（服务端快照优先，缺失时由调用方传本地角色）
    let tier: AccountRole
    /// 下一档；nil 表示已是 Ultra
    let nextTier: AccountRole?

    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @State private var isSubmitting = false
    @State private var alertItem: AlertItem?
    @State private var didSubmit = false

    private var request: VIPUpgradeRequest? { appState.vipUpgradeRequest }

    private var isPending: Bool { request?.status == .pending }

    private var targetTitle: String {
        guard let nextTier else { return L10n.string("tier_ultra") }
        return L10n.string(nextTier.titleKey)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                PageMakeBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        tierCard
                        benefitsCard

                        if let request {
                            statusCard(request)
                        }

                        if nextTier == nil {
                            PageMakeCard {
                                Label(L10n.string("vip_request_no_next_tier"), systemImage: "checkmark.seal.fill")
                                    .font(.subheadline)
                                    .foregroundStyle(Theme.premium)
                            }
                        } else if !isPending && !didSubmit {
                            noteCard

                            Button {
                                Task { await submit() }
                            } label: {
                                if isSubmitting {
                                    ProgressView().tint(Theme.label)
                                } else {
                                    Label(L10n.format("vip_request_upgrade_to", targetTitle),
                                          systemImage: "paperplane.fill")
                                }
                            }
                            .buttonStyle(PrimaryButtonStyle())
                            .disabled(isSubmitting)
                        }

                        Label(L10n.string("vip_request_privacy_note"), systemImage: "lock.shield.fill")
                            .font(.caption)
                            .foregroundStyle(Theme.secondaryLabel)
                            .padding(.horizontal, 4)
                    }
                    .padding(Theme.screenPadding)
                }
            }
            .navigationTitle(L10n.format("vip_request_page_title", targetTitle))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("done")) { dismiss() }
                }
            }
            .task {
                await appState.refreshVIPUpgradeRequest()
            }
            .alert(item: $alertItem) { item in
                Alert(
                    title: Text(L10n.string(item.titleKey)),
                    message: Text(item.message),
                    dismissButton: .default(Text(L10n.string("done"))) {
                        if didSubmit { dismiss() }
                    }
                )
            }
        }
    }

    // MARK: - 等级

    private var tierCard: some View {
        PageMakeCard(tint: Theme.premiumTint) {
            VStack(alignment: .leading, spacing: 12) {
                Label(L10n.string("vip_request_benefits_title"), systemImage: "crown.fill")
                    .font(.system(.title3, design: .serif, weight: .bold))
                    .foregroundStyle(Theme.premium)

                HStack(spacing: 10) {
                    tierBadge(title: L10n.string("vip_current_tier"),
                              value: L10n.string(tier.titleKey),
                              tint: Theme.secondaryLabel)
                    Image(systemName: "arrow.right")
                        .font(.caption.bold())
                        .foregroundStyle(Theme.tertiaryLabel)
                    tierBadge(title: L10n.string("vip_next_tier"),
                              value: targetTitle,
                              tint: Theme.premium)
                }
            }
        }
    }

    private func tierBadge(title: String, value: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(Theme.secondaryLabel)
            Text(value)
                .font(.system(.subheadline, design: .rounded, weight: .bold))
                .foregroundStyle(tint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .glassPanel(radius: Theme.controlRadius)
    }

    private var benefitsCard: some View {
        PageMakeCard {
            Text(L10n.string("vip_request_benefits"))
                .font(.subheadline)
                .foregroundStyle(Theme.secondaryLabel)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - 申请状态

    private func statusCard(_ request: VIPUpgradeRequest) -> some View {
        PageMakeCard {
            VStack(alignment: .leading, spacing: 8) {
                Text(statusTitle(request))
                    .font(.system(.subheadline, design: .rounded, weight: .bold))
                    .foregroundStyle(Theme.label)
                Text(statusDetail(request))
                    .font(.caption)
                    .foregroundStyle(Theme.secondaryLabel)
                if request.status == .rejected, !request.reviewNote.isEmpty {
                    Text(L10n.format("vip_request_rejected_reason", request.reviewNote))
                        .font(.caption)
                        .foregroundStyle(Theme.highlight)
                }
            }
        }
    }

    private var noteCard: some View {
        PageMakeCard {
            VStack(alignment: .leading, spacing: 10) {
                Text(L10n.string("vip_request_note_label"))
                    .font(.system(.subheadline, design: .rounded, weight: .bold))
                    .foregroundStyle(Theme.label)
                TextEditor(text: $note)
                    .font(.system(.footnote, design: .rounded))
                    .foregroundStyle(Theme.label)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 110)
                    .padding(8)
                    .background(Theme.elevatedBackground,
                                in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .onChange(of: note) { _, value in
                        if value.count > 300 {
                            note = String(value.prefix(300))
                        }
                    }
                Text(L10n.string("vip_request_note_hint"))
                    .font(.caption2)
                    .foregroundStyle(Theme.secondaryLabel)
            }
        }
    }

    private func statusTitle(_ request: VIPUpgradeRequest) -> String {
        switch request.status {
        case .pending: return L10n.string("vip_request_pending_title")
        case .approved: return L10n.string("vip_request_approved_title")
        case .rejected: return L10n.string("vip_request_rejected_title")
        }
    }

    private func statusDetail(_ request: VIPUpgradeRequest) -> String {
        let requested = request.requestedTier.map { L10n.string($0.titleKey) } ?? targetTitle
        switch request.status {
        case .pending:
            return L10n.format("vip_request_pending_tier_detail", requested)
        case .approved:
            return L10n.format("vip_request_approved_tier_detail", requested)
        case .rejected:
            return L10n.string("vip_request_rejected_detail")
        }
    }

    private func submit() async {
        isSubmitting = true
        defer { isSubmitting = false }
        let error = await appState.submitVIPUpgradeRequest(
            note: note.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        if let error {
            alertItem = AlertItem(message: error)
            return
        }
        didSubmit = true
        alertItem = AlertItem(
            message: L10n.string("vip_request_submitted_message"),
            titleKey: "vip_request_submitted_title"
        )
    }
}
