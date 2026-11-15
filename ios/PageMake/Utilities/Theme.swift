import SwiftUI
import UIKit

/// 设计令牌（玻璃改版）。
///
/// 与上一版的差别：上一版把「层次」交给留白与 hairline，结果卡片在纯色底上
/// 几乎没有质感（玻璃采样到的是同一块纯色，看起来就是一块灰板）。这一版：
/// - 背景做成**有纵深的分层渐变**（底色 + 两团大范围柔光），玻璃才有东西可折射；
/// - 卡片用 `.ultraThinMaterial` + 顶部高光 + hairline 描边 + 极淡投影，
///   在浅色/深色下都像一块悬在背景上的玻璃；
/// - 圆角整体放大一档（玻璃靠圆角显柔和），间距同步放宽；
/// - 主按钮改胶囊 + 强调色渐变，次按钮为玻璃胶囊。
///
/// 历史命名（coral / sea / gold / highlight）保留，避免跨文件大改。
enum Theme {
    // MARK: - 语义色

    static let background = PageMakeTheme.paper
    static let groupedBackground = PageMakeTheme.paperWarm
    static let elevatedBackground = PageMakeTheme.surface
    static let label = PageMakeTheme.ink
    static let secondaryLabel = PageMakeTheme.inkSoft
    static let tertiaryLabel = PageMakeTheme.inkSoft.opacity(0.72)
    static let separator = PageMakeTheme.border
    static let accent = PageMakeTheme.coral

    /// 强调色：只用于图标、徽章、主按钮与玻璃 tint
    static let highlight = PageMakeTheme.coral
    static let positive = PageMakeTheme.sea
    static let premium = PageMakeTheme.gold

    // MARK: - 圆角（玻璃需要更圆的转角）

    static let cardRadius: CGFloat = 24
    static let panelRadius: CGFloat = 20
    static let controlRadius: CGFloat = 16
    static let barRadius: CGFloat = 28

    // MARK: - 间距

    static let screenPadding: CGFloat = 18
    static let cardPadding: CGFloat = 18
    static let sectionSpacing: CGFloat = 18
    static let rowSpacing: CGFloat = 12

    // MARK: - 玻璃

    /// 卡片玻璃 tint：再降一档，让背景透上来（tint 越淡越"透"）
    static let cardTint = PageMakeTheme.coral.opacity(0.035)
    static let premiumTint = PageMakeTheme.gold.opacity(0.08)

    /// 玻璃描边：浅色用深色 hairline，深色用浅色 hairline。
    /// 略加重——玻璃的"存在感"主要来自边缘那一圈，而不是填充。
    static let glassStroke = dynamic(light: 0.10, dark: 0.17, isWhite: false)
    /// 玻璃顶部高光：模拟光源从上方打过来的边缘反光（拉到接近纯白）
    static let glassHighlight = dynamic(light: 1.0, dark: 0.16, isWhite: true)
    /// 玻璃投影：略加深，把卡片更明显地"抬"起来
    static let glassShadow = dynamic(light: 0.13, dark: 0.62, isWhite: false)

    /// 玻璃面斜向反光：左上亮、右下透，制造"一块玻璃"而不是"一块半透明色块"的观感
    static let glassSheen = LinearGradient(
        colors: [
            Color.white.opacity(0.20),
            Color.white.opacity(0.05),
            Color.clear,
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

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

    /// 浅色/深色自适应灰度色（alpha 由参数给）
    private static func dynamic(light: Double, dark: Double, isWhite: Bool) -> Color {
        Color(uiColor: UIColor { traits in
            let alpha = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(white: isWhite ? 1 : 0, alpha: alpha)
        })
    }
}

extension View {
    /// 标准玻璃面板：材质底 + tint + hairline + 顶部高光 + 极淡投影。
    ///
    /// 用 `.ultraThinMaterial` 而不是 `glassEffect`：卡片往往成组出现在滚动列表里，
    /// 材质模糊更省、文字更清晰，也更接近 ChatGPT 那种"磨砂玻璃卡片"的观感。
    /// 悬浮栏（TabBar / 构建栏）仍用原生 `glassEffect` 展示液态玻璃。
    func glassPanel(radius: CGFloat = Theme.panelRadius) -> some View {
        glassPanel(tint: Theme.cardTint, radius: radius)
    }

    /// 带强调色 tint 的玻璃面板：VIP 卡、主视觉等需要「更贵一点」的位置。
    ///
    /// 四层叠出玻璃感：材质模糊（透）→ 品牌 tint（色）→ 斜向反光（面）→
    /// 边缘高光描边（棱）+ 投影（浮起）。想让玻璃更透就降 tint，想更浓就加高光/描边。
    func glassPanel(tint: Color, radius: CGFloat = Theme.panelRadius) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        return self
            .background(.ultraThinMaterial, in: shape)
            .background(tint, in: shape)
            .overlay(shape.fill(Theme.glassSheen).allowsHitTesting(false))
            .overlay(
                shape.strokeBorder(
                    LinearGradient(
                        colors: [Theme.glassHighlight, Theme.glassStroke],
                        startPoint: .top,
                        endPoint: .bottom
                    ),
                    lineWidth: 1
                )
            )
            .shadow(color: Theme.glassShadow, radius: 20, x: 0, y: 10)
    }
}
