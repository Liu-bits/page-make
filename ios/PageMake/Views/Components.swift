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

/// Page-make 的视觉基础（简约高级改版）：冷灰中性面 + 单一靛蓝强调色。
/// 设计原则：色彩只保留「中性面 + 一个强调色」两档，强调色仅小面积出现；
/// 层次靠留白与 hairline 边界表达，不靠渐变、网格与彩色光斑。
/// 历史命名保留（coral / sea / gold），避免跨文件引用改动；值已随改版更新。
enum PageMakeTheme {
    static let ink = adaptiveColor(light: 0x101114, dark: 0xF4F4F6)
    static let inkSoft = adaptiveColor(light: 0x6B6F76, dark: 0x9EA1A8)
    static let paper = adaptiveColor(light: 0xF7F7F8, dark: 0x0B0B0D)
    static let paperWarm = adaptiveColor(light: 0xF1F1F3, dark: 0x121215)
    static let surface = adaptiveColor(light: 0xFFFFFF, dark: 0x131316)
    static let surfaceSoft = adaptiveColor(light: 0xF2F2F4, dark: 0x1A1A1E)
    static let border = adaptiveColor(light: 0xE3E3E6, dark: 0x27272B)
    static let shadow = adaptiveColor(light: 0xD9D9DC, dark: 0x000000)
    static let codeBackground = adaptiveColor(light: 0xFFFFFF, dark: 0x0E0E10)
    static let codeText = adaptiveColor(light: 0x000000, dark: 0xE9E9EC)
    /// 强调色：靛蓝。深色模式提亮一档保证对比度
    static let coral = adaptiveColor(light: 0x4050D8, dark: 0x8C9BF2)
    static let sea = adaptiveColor(light: 0x2F7D6B, dark: 0x7CC7B4)
    static let gold = adaptiveColor(light: 0xA07C2C, dark: 0xD9BC77)
    /// 强调色之上的前景色（实心主按钮文字）：深色模式强调色变浅 → 用深色字
    static let onAccent = adaptiveColor(light: 0xFFFFFF, dark: 0x101118)

    /// 主视觉渐变：石墨双色，纯中性（简约高级：渐变只做纵深，不做彩色装饰）
    static let heroGradient = LinearGradient(
        colors: [
            adaptiveColor(light: 0x15161A, dark: 0x101113),
            adaptiveColor(light: 0x24262E, dark: 0x191B21)
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

/// 全局背景：分层渐变 + 两团大范围柔光。
///
/// 玻璃卡片采样的是它背后的像素——纯色底上玻璃只会变成一块灰板。
/// 这里给背景做出纵深：顶部偏亮的底色渐变 + 右上冷调光晕 + 左下暖调光晕，
/// 玻璃压上去才有折射感，同时保持中性不花哨。
struct PageMakeBackground: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [PageMakeTheme.paper, PageMakeTheme.paperWarm],
                startPoint: .top,
                endPoint: .bottom
            )
            GeometryReader { proxy in
                let w = proxy.size.width
                Circle()
                    .fill(PageMakeTheme.coral.opacity(0.13))
                    .frame(width: w * 1.15, height: w * 1.15)
                    .blur(radius: 120)
                    .offset(x: w * 0.38, y: -w * 0.62)
                Circle()
                    .fill(PageMakeTheme.sea.opacity(0.07))
                    .frame(width: w * 0.95, height: w * 0.95)
                    .blur(radius: 130)
                    .offset(x: -w * 0.5, y: w * 0.7)
            }
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

/// 项目状态徽章：低调胶囊——语义色只落在文字上，底色几乎不可见
struct StatusBadge: View {
    let status: ProjectStatus

    var body: some View {
        Text(L10n.string(status.titleKey))
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(backgroundColor.opacity(0.10), in: Capsule())
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

/// 主要按钮：强调色渐变胶囊 + 顶部高光 + 柔光投影。
/// 胶囊 + 轻微渐变是「玻璃系」界面里最稳的主操作形态（ChatGPT 的主按钮即此形态）。
struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(.headline, weight: .semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .foregroundStyle(PageMakeTheme.onAccent)
            .background(
                Capsule(style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [PageMakeTheme.coral, PageMakeTheme.coral.opacity(0.86)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
            )
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(Theme.glassHighlight.opacity(0.28), lineWidth: 0.8)
            )
            .shadow(color: PageMakeTheme.coral.opacity(0.26), radius: 14, x: 0, y: 6)
            .opacity(configuration.isPressed ? 0.9 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.16), value: configuration.isPressed)
    }
}

/// 次要按钮：玻璃胶囊 + hairline 描边，把注意力让给主操作。
struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(.headline, weight: .semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .foregroundStyle(Theme.label)
            .background(.ultraThinMaterial, in: Capsule(style: .continuous))
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(
                        LinearGradient(
                            colors: [Theme.glassHighlight, Theme.glassStroke],
                            startPoint: .top,
                            endPoint: .bottom
                        ),
                        lineWidth: 0.9
                    )
            )
            .shadow(color: Theme.glassShadow, radius: 10, x: 0, y: 4)
            .opacity(configuration.isPressed ? 0.86 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.16), value: configuration.isPressed)
    }
}

/// 底部双入口：左侧标准新建/作品工作台，右侧个人设置。
/// 简约改版：去掉嵌套玻璃胶囊与强调色 tint——悬浮玻璃条只保留一块，
/// 选中态用图标填充 + 强调色文字表达，视觉更安静。
struct MainTabBar: View {
    @Binding var selection: RootView.MainTab
    let onCreateTapped: () -> Void

    var body: some View {
        GlassEffectContainer(spacing: 16) {
            HStack(spacing: 6) {
                tabButton(
                    tab: .workspace,
                    icon: "square.grid.2x2",
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
            .padding(8)
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
                    .font(.system(size: 10, weight: .semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .foregroundStyle(isSelected ? PageMakeTheme.coral : Theme.secondaryLabel)
            // 选中态用一层淡胶囊托底，比只改颜色更像"玻璃里的滑块"
            .background(
                Capsule(style: .continuous)
                    .fill(isSelected ? PageMakeTheme.coral.opacity(0.15) : Color.clear)
            )
            .contentShape(Capsule(style: .continuous))
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
