import SwiftUI
import UIKit

/// 外观偏好：跟随系统 / 浅色 / 深色。
/// 原始值持久化到 AppStorage，App 与设置页共用同一份配置。
enum AppearanceMode: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var titleKey: String {
        switch self {
        case .system: return "appearance_system"
        case .light: return "appearance_light"
        case .dark: return "appearance_dark"
        }
    }

    var icon: String {
        switch self {
        case .system: return "circle.lefthalf.filled"
        case .light: return "sun.max.fill"
        case .dark: return "moon.stars.fill"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

/// 系统颜色方案变化时自动重绘的主题色。
private func adaptiveColor(light: UInt32, dark: UInt32) -> Color {
    Color(uiColor: UIColor { traits in
        UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
    })
}

private extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

/// Page-make 的视觉基础：纸张暖白 + 墨蓝 + 珊瑚强调色。
/// 颜色集中在这里，避免各页面各写一套渐变导致风格漂移。
enum PageMakeTheme {
    static let ink = adaptiveColor(light: 0x141F2E, dark: 0xF2EEE5)
    static let inkSoft = adaptiveColor(light: 0x47576D, dark: 0xAAB5C2)
    static let paper = adaptiveColor(light: 0xF6F4EC, dark: 0x0A1017)
    static let paperWarm = adaptiveColor(light: 0xFBF7EC, dark: 0x111A24)
    static let surface = adaptiveColor(light: 0xFFFEF9, dark: 0x131D27)
    static let surfaceSoft = adaptiveColor(light: 0xF7F2E7, dark: 0x18242F)
    static let border = adaptiveColor(light: 0xE6E0D3, dark: 0x293746)
    static let shadow = adaptiveColor(light: 0xD5CDBE, dark: 0x000000)
    static let codeBackground = adaptiveColor(light: 0xFFFFFF, dark: 0x0D151E)
    static let codeText = adaptiveColor(light: 0x000000, dark: 0xE8EDF3)
    static let coral = Color(red: 0.91, green: 0.33, blue: 0.25)
    static let sea = Color(red: 0.08, green: 0.48, blue: 0.50)
    static let gold = Color(red: 0.84, green: 0.61, blue: 0.20)

    static let heroGradient = LinearGradient(
        colors: [
            adaptiveColor(light: 0x132231, dark: 0x101B26),
            adaptiveColor(light: 0x13504F, dark: 0x123F43)
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
}

/// 主页面滚动区尾部留白。
///
/// 底部双入口通过 `safeAreaInset` 参与布局，但长列表滚到底时最后一张卡片
/// 仍会紧贴栏体；这里统一补足一个栏体高度并随辅助字号略增，避免各页面
/// 分散写 84/96/104pt，也确保最后一项可以完整滑到栏体上方。
struct WorkspaceBottomSpacer: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Color.clear
            .frame(height: dynamicTypeSize.isAccessibilitySize ? 104 : 72)
    }
}

/// 全局背景：系统语义底色 + 柔和光斑，建立“创作工作台”氛围。
/// 底色交给系统（浅色/深色自动适配），不再写死暖白/墨黑。
struct PageMakeBackground: View {
    var body: some View {
        ZStack {
            Theme.background
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
                    context.stroke(path, with: .color(Theme.separator.opacity(0.35)), lineWidth: 0.5)
                }
                .frame(width: proxy.size.width, height: proxy.size.height)
            }
            .mask(
                LinearGradient(colors: [.black.opacity(0.7), .clear], startPoint: .top, endPoint: .bottom)
            )

            Circle()
                .fill(Theme.highlight.opacity(0.12))
                .frame(width: 280, height: 280)
                .blur(radius: 70)
                .offset(x: 150, y: -300)

            Circle()
                .fill(Theme.positive.opacity(0.10))
                .frame(width: 320, height: 320)
                .blur(radius: 85)
                .offset(x: -170, y: 320)
        }
        .ignoresSafeArea()
    }
}

/// 统一的内容卡片：液态玻璃面板，自动适配浅色与深色模式。
struct PageMakeCard<Content: View>: View {
    var padding: CGFloat = Theme.cardPadding
    /// 可选强调色 tint：VIP 卡等需要更醒目，但仍然是玻璃质感而不是色块
    var tint: Color? = nil
    @ViewBuilder var content: Content

    var body: some View {
        Group {
            if let tint {
                content
                    .padding(padding)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassPanel(tint: tint, radius: Theme.cardRadius)
            } else {
                content
                    .padding(padding)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassPanel(radius: Theme.cardRadius)
            }
        }
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
        .glassPanel(radius: 14)
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
        case .ready: return Theme.positive
        case .uploading, .processing: return Theme.accent
        case .failed: return Theme.highlight
        case .expired: return Theme.premium
        }
    }
}

/// 主要按钮：液态玻璃 + 强调色 tint（prominent 但不使用整块饱和底色）
struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(.headline, design: .rounded, weight: .bold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .foregroundStyle(Theme.label)
            .glassEffect(
                .regular.tint(Theme.highlight.opacity(0.42)).interactive(),
                in: RoundedRectangle(cornerRadius: 15, style: .continuous)
            )
            .opacity(configuration.isPressed ? 0.82 : 1)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.easeOut(duration: 0.16), value: configuration.isPressed)
    }
}

/// 次要按钮：中性玻璃，用于不抢主操作的入口。
struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(.headline, design: .rounded, weight: .semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
            .foregroundStyle(Theme.label)
            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
            .opacity(configuration.isPressed ? 0.78 : 1)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.easeOut(duration: 0.16), value: configuration.isPressed)
    }
}

/// 底部双入口：左侧标准新建/作品工作台，右侧个人设置。
/// 设置从弹窗改为独立页签，才能稳定承载外观模式等长期偏好。
/// 视觉上是一整块悬浮玻璃，两个页签各是一枚更小的玻璃胶囊（同屏多玻璃 → 容器合并）。
struct MainTabBar: View {
    @Binding var selection: RootView.MainTab
    let onCreateTapped: () -> Void

    var body: some View {
        GlassEffectContainer(spacing: 16) {
            HStack(spacing: 6) {
                tabButton(
                    tab: .workspace,
                    icon: "square.grid.2x2.fill",
                    selectedIcon: "plus.square.fill",
                    title: L10n.string("tab_create"),
                    action: {
                        if selection == .workspace {
                            onCreateTapped()
                        } else {
                            selection = .workspace
                        }
                    }
                )

                tabButton(
                    tab: .settings,
                    icon: "person.crop.circle",
                    selectedIcon: "person.crop.circle.fill",
                    title: L10n.string("tab_profile"),
                    action: {
                        selection = .settings
                    }
                )
            }
            .padding(6)
            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: Theme.barRadius, style: .continuous))
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 6)
    }

    private func tabButton(
        tab: RootView.MainTab,
        icon: String,
        selectedIcon: String,
        title: String,
        action: @escaping () -> Void
    ) -> some View {
        let isSelected = selection == tab
        return Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: isSelected ? selectedIcon : icon)
                    .font(.system(size: 18, weight: .semibold))
                    .frame(height: 22)
                Text(title)
                    .font(.system(size: 10, weight: .bold, design: .rounded))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .foregroundStyle(isSelected ? Theme.label : Theme.secondaryLabel)
            .glassEffect(
                isSelected
                    ? .regular.tint(Theme.highlight.opacity(0.30)).interactive()
                    : .regular,
                in: RoundedRectangle(cornerRadius: 20, style: .continuous)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
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
