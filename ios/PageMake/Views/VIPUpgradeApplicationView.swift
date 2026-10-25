import SwiftUI

/// 游客 VIP 升级申请：提交后由管理后台审核，不创建邮箱账号或密码。
struct VIPUpgradeApplicationView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @State private var isSubmitting = false
    @State private var alertItem: AlertItem?
    @State private var didSubmit = false

    private var isPending: Bool {
        appState.vipUpgradeRequest?.status == .pending
    }

    var body: some View {
        NavigationStack {
            ZStack {
                PageMakeBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        PageMakeCard {
                            VStack(alignment: .leading, spacing: 12) {
                                Label(L10n.string("vip_request_benefits_title"), systemImage: "crown.fill")
                                    .font(.system(.title3, design: .serif, weight: .bold))
                                    .foregroundStyle(PageMakeTheme.gold)
                                Text(L10n.string("vip_request_benefits"))
                                    .font(.subheadline)
                                    .foregroundStyle(PageMakeTheme.inkSoft)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }

                        if let request = appState.vipUpgradeRequest {
                            PageMakeCard {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(statusTitle(request))
                                        .font(.system(.subheadline, design: .rounded, weight: .bold))
                                        .foregroundStyle(PageMakeTheme.ink)
                                    Text(statusDetail(request))
                                        .font(.caption)
                                        .foregroundStyle(PageMakeTheme.inkSoft)
                                    if !request.reviewNote.isEmpty, request.status == .rejected {
                                        Text(request.reviewNote)
                                            .font(.caption)
                                            .foregroundStyle(PageMakeTheme.coral)
                                    }
                                }
                            }
                        }

                        if !isPending && !didSubmit {
                            PageMakeCard {
                                VStack(alignment: .leading, spacing: 10) {
                                    Text(L10n.string("vip_request_note_label"))
                                        .font(.system(.subheadline, design: .rounded, weight: .bold))
                                        .foregroundStyle(PageMakeTheme.ink)
                                    TextEditor(text: $note)
                                        .font(.system(.footnote, design: .rounded))
                                        .scrollContentBackground(.hidden)
                                        .frame(minHeight: 110)
                                        .padding(8)
                                        .background(PageMakeTheme.surfaceSoft,
                                                    in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                        .onChange(of: note) { _, value in
                                            if value.count > 300 {
                                                note = String(value.prefix(300))
                                            }
                                        }
                                    Text(L10n.string("vip_request_note_hint"))
                                        .font(.caption2)
                                        .foregroundStyle(PageMakeTheme.inkSoft)
                                }
                            }

                            Button {
                                Task { await submit() }
                            } label: {
                                if isSubmitting {
                                    ProgressView().tint(.white)
                                } else {
                                    Label(L10n.string("vip_request_submit"), systemImage: "paperplane.fill")
                                }
                            }
                            .buttonStyle(PrimaryButtonStyle())
                            .disabled(isSubmitting)
                        }

                        Label(L10n.string("vip_request_privacy_note"), systemImage: "lock.shield.fill")
                            .font(.caption)
                            .foregroundStyle(PageMakeTheme.inkSoft)
                            .padding(.horizontal, 4)
                    }
                    .padding(16)
                }
            }
            .navigationTitle(L10n.string("vip_upgrade_title"))
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

    private func statusTitle(_ request: VIPUpgradeRequest) -> String {
        switch request.status {
        case .pending: return L10n.string("vip_request_pending_title")
        case .approved: return L10n.string("vip_request_approved_title")
        case .rejected: return L10n.string("vip_request_rejected_title")
        }
    }

    private func statusDetail(_ request: VIPUpgradeRequest) -> String {
        switch request.status {
        case .pending: return L10n.string("vip_request_pending_detail")
        case .approved: return L10n.string("vip_request_approved_detail")
        case .rejected: return L10n.string("vip_request_rejected_detail")
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
