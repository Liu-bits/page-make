import SwiftUI

/// 应用内文档展示页（隐私政策 / 用户协议）
struct DocumentView: View {
    let document: AppDocument

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(verbatim: DocumentStore.text(for: document))
                    .font(.body)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            .background(Color(.systemBackground))
            .navigationTitle(L10n.string(document.titleKey))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.string("done")) { dismiss() }
                }
            }
        }
    }
}
