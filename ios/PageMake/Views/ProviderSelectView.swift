import SwiftUI

/// 创建流程：线路选择 → 上传队列
struct CreateFlowView: View {
    let files: [PickedFile]

    @Environment(\.dismiss) private var dismiss
    @State private var selection: HostProvider?
    @State private var confirmed: HostProvider?

    var body: some View {
        if let provider = confirmed {
            UploadQueueView(files: files, provider: provider)
        } else {
            providerSelect
        }
    }

    private var providerSelect: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text(L10n.string("provider_intro"))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                ForEach(HostProvider.allCases) { provider in
                    providerCard(provider)
                }

                Spacer()

                Button(L10n.string("next_step")) {
                    if let selection {
                        confirmed = selection
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(selection == nil)
                .opacity(selection == nil ? 0.4 : 1)

                Text(L10n.string("provider_no_default"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
            .padding()
            .navigationTitle(L10n.string("choose_provider"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("cancel")) { dismiss() }
                }
            }
        }
    }

    private func providerCard(_ provider: HostProvider) -> some View {
        Button {
            selection = provider
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L10n.string(provider.titleKey))
                        .font(.headline)
                        .foregroundStyle(.primary)
                    Text(L10n.string(provider.detailKey))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if selection == provider {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(Color.accentColor)
                }
            }
            .padding()
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .stroke(selection == provider ? Color.accentColor : .clear, lineWidth: 2)
            }
        }
        .buttonStyle(.plain)
    }
}
