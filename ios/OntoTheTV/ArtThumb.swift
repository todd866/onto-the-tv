import SwiftUI
import UIKit

enum ArtLoader {
    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 8
        config.timeoutIntervalForResource = 8
        config.urlCache = URLCache(memoryCapacity: 32 * 1024 * 1024, diskCapacity: 64 * 1024 * 1024)
        return URLSession(configuration: config)
    }()
    private static let memory = NSCache<NSURL, UIImage>()

    static func image(_ url: URL?) async -> UIImage? {
        guard let url else { return nil }
        if let cached = memory.object(forKey: url as NSURL) { return cached }
        var request = URLRequest(url: url)
        let token = KeychainToken.read()
        if !token.isEmpty {
            request.setValue(token, forHTTPHeaderField: "X-Onto-Token")
        }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let image = UIImage(data: data) else { return nil }
            memory.setObject(image, forKey: url as NSURL)
            return image
        } catch {
            return nil
        }
    }
}

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
