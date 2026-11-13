import SwiftUI

/// 液态玻璃设计令牌。
///
/// 约定：
/// - 颜色一律取系统语义色（`Color(.systemBackground)` / `.label` / …），由系统负责
///   浅色、深色与增强对比度，不在页面里写死黑白或大面积饱和色；
/// - 强调色只做小面积点缀（图标、徽章、玻璃 tint），不做整块底色；
/// - 圆角、间距、卡片内边距统一在这里维护，避免各页面各写一套数值导致风格漂移。
enum Theme {
    // MARK: - 语义色

    static let background = Color(.systemBackground)
    static let groupedBackground = Color(.secondarySystemBackground)
    static let elevatedBackground = Color(.tertiarySystemBackground)
    static let label = Color(.label)
    static let secondaryLabel = Color(.secondaryLabel)
    static let tertiaryLabel = Color(.tertiaryLabel)
    static let separator = Color(.separator)
    static let accent = Color.accentColor

    /// 强调色：只用于图标、徽章与玻璃 tint
    static let highlight = PageMakeTheme.coral
    static let positive = PageMakeTheme.sea
    static let premium = PageMakeTheme.gold

    // MARK: - 圆角

    static let cardRadius: CGFloat = 22
    static let panelRadius: CGFloat = 18
    static let controlRadius: CGFloat = 14
    static let barRadius: CGFloat = 26

    // MARK: - 间距

    static let screenPadding: CGFloat = 16
    static let cardPadding: CGFloat = 18
    static let sectionSpacing: CGFloat = 16
    static let rowSpacing: CGFloat = 12

    // MARK: - 玻璃

    /// 卡片玻璃 tint：极低透明度的强调色，让玻璃有品牌温度但不变成色块
    static let cardTint = PageMakeTheme.coral.opacity(0.10)
    static let premiumTint = PageMakeTheme.gold.opacity(0.16)

    static var cardShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: cardRadius, style: .continuous)
    }

    static var panelShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: panelRadius, style: .continuous)
    }

    static var controlShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: controlRadius, style: .continuous)
    }

    static var barShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: barRadius, style: .continuous)
    }
}

extension View {
    /// 标准玻璃面板：同屏多个玻璃元素时由调用方包一层 `GlassEffectContainer`。
    func glassPanel(radius: CGFloat = Theme.panelRadius) -> some View {
        glassEffect(.regular, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    }

    /// 带强调色 tint 的玻璃面板：用于 VIP 卡、主按钮等需要「更贵一点」的位置。
    func glassPanel(tint: Color, radius: CGFloat = Theme.panelRadius) -> some View {
        glassEffect(
            .regular.tint(tint).interactive(),
            in: RoundedRectangle(cornerRadius: radius, style: .continuous)
        )
    }
}
