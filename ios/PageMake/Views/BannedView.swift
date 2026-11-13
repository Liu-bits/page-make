import SwiftUI

/// 封号页：等级（L1-L4）+ 原因 + 解封时间（L4 永久）。
///
/// 封禁时 RootView 会整页替换主界面并移除底部 TabBar。早期版本这里只有
/// 文字说明、没有任何按钮，被误封的用户既不能申诉也不能退出登录，
/// 会永久卡在这一页（重装才能换身份）。现在保留申诉入口，并提供登出入口。
struct BannedView: View {
    let ban: BanInfo

    @EnvironmentObject private var appState: AppState
    @State private var showFeedback = false

    var body: some View {
        ZStack {
            PageMakeBackground()
            ScrollView {
                VStack(spacing: 20) {
                    Image(systemName: "hand.raised.fill")
                        .font(.system(size: 56))
                        .foregroundStyle(Theme.highlight)
                        .padding(.top, 40)

                    Text(L10n.string("banned_title"))
                        .font(.system(.title2, design: .serif, weight: .bold))
                        .foregroundStyle(Theme.label)

                    VStack(spacing: 12) {
                        infoRow(label: L10n.string("ban_level"), value: "L\(ban.level)")
                        infoRow(label: L10n.string("ban_reason"), value: ban.reason)
                        if ban.permanent || ban.level >= 4 {
                            infoRow(label: L10n.string("ban_until"), value: L10n.string("ban_permanent"))
                        } else if let until = ban.until {
                            infoRow(label: L10n.string("ban_until"), value: DateParsing.display(until))
                        }
                    }
                    .padding(Theme.cardPadding)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassEffect(.regular, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
                    .padding(.horizontal, 24)

                    Text(L10n.string("ban_note"))
                        .font(.footnote)
                        .foregroundStyle(Theme.secondaryLabel)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)

                    VStack(spacing: 11) {
                        // 申诉入口 = 反馈页；封禁状态仍持有会话，反馈接口可正常提交
                        Button {
                            showFeedback = true
                        } label: {
                            Label(L10n.string("ban_appeal"), systemImage: "bubble.left.and.bubble.right.fill")
                        }
                        .buttonStyle(PrimaryButtonStyle())

                        Button {
                            appState.signOut()
                        } label: {
                            Label(L10n.string("sign_out"), systemImage: "rectangle.portrait.and.arrow.right")
                        }
                        .buttonStyle(SecondaryButtonStyle())

                        Text(L10n.string("ban_sign_out_hint"))
                            .font(.caption2)
                            .foregroundStyle(Theme.tertiaryLabel)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 32)
                }
            }
        }
        .sheet(isPresented: $showFeedback) {
            FeedbackView()
        }
    }

    private func infoRow(label: String, value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .foregroundStyle(Theme.secondaryLabel)
                .frame(width: 88, alignment: .leading)
            Text(value)
                .foregroundStyle(Theme.label)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.subheadline)
    }
}
