import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

/// 公开链接二维码（系统 CoreImage 生成，可分享图片）
struct QRCodeView: View {
    let project: Project

    @Environment(\.dismiss) private var dismiss

    private var urlString: String {
        project.publicURL?.absoluteString ?? ""
    }

    private var qrImage: UIImage? {
        guard !urlString.isEmpty else { return nil }
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(urlString.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
        let context = CIContext()
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                if let image = qrImage {
                    Image(uiImage: image)
                        .interpolation(.none)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: 260)
                        .padding(16)
                        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 20))

                    Text(urlString)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .lineLimit(3)
                        .padding(.horizontal)

                    Text(L10n.string("qr_hint"))
                        .font(.caption)
                        .foregroundStyle(.tertiary)

                    ShareLink(
                        item: Image(uiImage: image),
                        preview: SharePreview(project.name, image: Image(uiImage: image))
                    ) {
                        Label(L10n.string("share"), systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(.glass)
                } else {
                    Text(L10n.string("error_generic"))
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding()
            .navigationTitle(L10n.string("qr_code"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.string("done")) { dismiss() }
                }
            }
        }
    }
}
