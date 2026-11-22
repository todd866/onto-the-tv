import SwiftUI
import UIKit

/// The loader lives in Shared/ArtLoader.swift (token in a header, nothing cached on disk).
struct ArtThumb: View {
    var url: URL?
    var revision: Int
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Color(uiColor: .tertiarySystemFill)
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            }
        }
        .clipped()
        .task(id: "\(revision)|\(url?.absoluteString ?? "")") {
            image = nil
            image = await ArtLoader.image(url)
        }
    }
}
