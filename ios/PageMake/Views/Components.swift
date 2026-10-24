import SwiftUI

/// Page-make 的视觉基础：纸张暖白 + 墨蓝 + 珊瑚强调色。
/// 颜色集中在这里，避免各页面各写一套渐变导致风格漂移。
enum PageMakeTheme {
    static let ink = Color(red: 0.08, green: 0.12, blue: 0.18)
    static let inkSoft = Color(red: 0.28, green: 0.34, blue: 0.42)
    static let paper = Color(red: 0.965, green: 0.955, blue: 0.925)
    static let paperWarm = Color(red: 0.985, green: 0.968, blue: 0.925)
    static let coral = Color(red: 0.91, green: 0.33, blue: 0.25)
    static let sea = Color(red: 0.08, green: 0.48, blue: 0.50)
    static let gold = Color(red: 0.84, green: 0.61, blue: 0.20)

    static let heroGradient = LinearGradient(
        colors: [
            Color(red: 0.075, green: 0.13, blue: 0.20),
            Color(red: 0.075, green: 0.30, blue: 0.32)
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
}

/// 全局背景：用柔和光斑与细微网格建立“创作工作台”氛围，
/// 而不是一块没有层次的纯色背景。
struct PageMakeBackground: View {
    var body: some View {
        ZStack {
            PageMakeTheme.paper
            GeometryReader { proxy in
                Canvas { context, size in
                    let spacing: CGFloat = 24
                    var path = Path()
                    var x: CGFloat = 0
                    while x <= size.width {
                        path.move(to: CGPoint(x: x, y: 0))
                        path.addLine(to: CGPoint(x: x, y: size.height))
                        x += spacing
                    }
                    var y: CGFloat = 0
                    while y <= size.height {
                        path.move(to: CGPoint(x: 0, y: y))
                        path.addLine(to: CGPoint(x: size.width, y: y))
                        y += spacing
                    }
                    context.stroke(path, with: .color(PageMakeTheme.ink.opacity(0.035)), lineWidth: 0.5)
                }
                .frame(width: proxy.size.width, height: proxy.size.height)
            }
            .mask(
                LinearGradient(colors: [.black.opacity(0.8), .clear], startPoint: .top, endPoint: .bottom)
            )

            Circle()
                .fill(PageMakeTheme.coral.opacity(0.14))
                .frame(width: 280, height: 280)
                .blur(radius: 70)
                .offset(x: 150, y: -300)

            Circle()
                .fill(PageMakeTheme.sea.opacity(0.12))
                .frame(width: 320, height: 320)
                .blur(radius: 85)
                .offset(x: -170, y: 320)
        }
        .ignoresSafeArea()
    }
}

/// 统一的白色内容卡片。
struct PageMakeCard<Content: View>: View {
    var padding: CGFloat = 18
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.white.opacity(0.82), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(PageMakeTheme.ink.opacity(0.07), lineWidth: 1)
            }
            .shadow(color: PageMakeTheme.ink.opacity(0.07), radius: 18, x: 0, y: 8)
    }
}

/// 非阻塞错误横幅：网络/服务错误显示在内容上方，不抢占 presentation，
/// 因而不会与 sheet、alert、navigationDestination 互相卡死。
struct ErrorBanner: View {
    let message: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil
    var onDismiss: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(PageMakeTheme.coral)
            Text(message)
                .font(.footnote)
                .lineLimit(3)
            Spacer(minLength: 4)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.footnote.bold())
            }
            if let onDismiss {
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                }
                .accessibilityLabel(L10n.string("done"))
            }
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .padding(.horizontal, 12)
        .padding(.top, 6)
    }
}

/// 通用小组件：AlertItem、状态徽章、主按钮
struct AlertItem: Identifiable {
    let id = UUID()
    let message: String
    /// 弹窗标题的本地化 key；默认"出错了"，成功提示类消息应传 "alert_tip"
    var titleKey: String = "alert_error"

    init(message: String, titleKey: String = "alert_error") {
        // 消息为空时回退到通用文案，避免出现只有标题的空弹窗
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        self.message = trimmed.isEmpty ? L10n.string("error_generic") : message
        self.titleKey = titleKey
    }
}

/// 项目状态徽章
struct StatusBadge: View {
    let status: ProjectStatus

    var body: some View {
        Text(L10n.string(status.titleKey))
            .font(.caption2.bold())
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(backgroundColor.opacity(0.15), in: Capsule())
            .foregroundStyle(backgroundColor)
    }

    private var backgroundColor: Color {
        switch status {
        case .ready: return PageMakeTheme.sea
        case .uploading, .processing: return Color(red: 0.16, green: 0.42, blue: 0.72)
        case .failed: return PageMakeTheme.coral
        case .expired: return PageMakeTheme.gold
        }
    }
}

/// 主要按钮（圆角胶囊）
struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(.headline, design: .rounded, weight: .bold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(
                LinearGradient(
                    colors: [PageMakeTheme.coral, Color(red: 0.79, green: 0.22, blue: 0.17)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ),
                in: RoundedRectangle(cornerRadius: 15, style: .continuous)
            )
            .foregroundStyle(.white)
            .shadow(color: PageMakeTheme.coral.opacity(0.24), radius: 12, y: 6)
            .opacity(configuration.isPressed ? 0.8 : 1)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.easeOut(duration: 0.16), value: configuration.isPressed)
    }
}

/// 次要按钮：白色纸张表面，用于不抢主操作的入口。
struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(.headline, design: .rounded, weight: .semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
            .background(.white.opacity(0.78), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .stroke(PageMakeTheme.ink.opacity(0.1), lineWidth: 1)
            }
            .foregroundStyle(PageMakeTheme.ink)
            .opacity(configuration.isPressed ? 0.75 : 1)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.easeOut(duration: 0.16), value: configuration.isPressed)
    }
}

/// 分享面板封装
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
