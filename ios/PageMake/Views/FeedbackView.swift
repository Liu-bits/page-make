import SwiftUI

/// 反馈 / 举报页
struct FeedbackView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var message = ""
    @State private var type: FeedbackType = .feedback
    @State private var alertItem: AlertItem?
    @State private var isSending = false

    enum FeedbackType: String, CaseIterable, Identifiable {
        case feedback
        case report

        var id: String { rawValue }

        var titleKey: String {
            switch self {
            case .feedback: return "feedback_type_feedback"
            case .report: return "feedback_type_report"
            }
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Picker(L10n.string("feedback_type"), selection: $type) {
                    ForEach(FeedbackType.allCases) { item in
                        Text(L10n.string(item.titleKey)).tag(item)
                    }
                }
                .pickerStyle(.segmented)

                Section {
                    TextEditor(text: $message)
                        .frame(minHeight: 140)
                } header: {
                    Text(L10n.string("feedback_message"))
                }
            }
            .navigationTitle(L10n.string("feedback"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.string("send")) {
                        Task { await send() }
                    }
                    .disabled(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSending)
                }
            }
            .overlay {
                if isSending { ProgressView() }
            }
            .alert(item: $alertItem) { item in
                Button(L10n.string("done"), role: .cancel) {}
            } message: {
                Text(item.message)
            }
        }
    }

    private func send() async {
        isSending = true
        defer { isSending = false }
        do {
            try await APIClient.shared.sendFeedback(
                type: type.rawValue,
                message: message.trimmingCharacters(in: .whitespacesAndNewlines),
                projectId: nil,
                errorCode: nil
            )
            dismiss()
        } catch {
            alertItem = AlertItem(message: L10n.string("error_generic"))
        }
    }
}
