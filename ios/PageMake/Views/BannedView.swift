import SwiftUI

/// 封号页：等级（L1-L4）+ 原因 + 解封时间（L4 永久）
struct BannedView: View {
    let ban: BanInfo

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "hand.raised.fill")
                .font(.system(size: 56))
                .foregroundStyle(.red)

            Text(L10n.string("banned_title"))
                .font(.title2.bold())

            VStack(spacing: 12) {
                infoRow(label: L10n.string("ban_level"), value: "L\(ban.level)")
                infoRow(label: L10n.string("ban_reason"), value: ban.reason)
                if ban.permanent || ban.level >= 4 {
                    infoRow(label: L10n.string("ban_until"), value: L10n.string("ban_permanent"))
                } else if let until = ban.until {
                    infoRow(label: L10n.string("ban_until"), value: DateParsing.display(until))
                }
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
            .padding(.horizontal, 24)

            Text(L10n.string("ban_note"))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            Spacer()
            Spacer()
        }
    }

    private func infoRow(label: String, value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .foregroundStyle(.secondary)
                .frame(width: 88, alignment: .leading)
            Text(value)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.subheadline)
    }
}
