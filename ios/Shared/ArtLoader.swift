import UIKit

/// Artwork for both apps. The pairing token travels in the `X-Onto-Token` header, never the URL, and only
/// to the configured server. The session is ephemeral with no URL cache, so neither the request (with its
/// header) nor the reply is written to disk; decoded images are kept in memory only.
enum ArtLoader {
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        config.timeoutIntervalForResource = 8
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        return URLSession(configuration: config)
    }()
    private static let memory: NSCache<NSURL, UIImage> = {
        let cache = NSCache<NSURL, UIImage>()
        cache.totalCostLimit = 48 * 1024 * 1024
        return cache
    }()

    /// The request ArtLoader sends; separate so tests can check the header without a network.
    static func request(for url: URL, base: String, token: String) -> URLRequest {
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if !token.isEmpty, TVAPI.isServer(url, base: base) {
            request.setValue(token, forHTTPHeaderField: "X-Onto-Token")
        }
        return request
    }

    /// Older builds fetched art through the shared, disk-backed URL cache (tvOS with `?t=` in the URL,
    /// iOS with the token header on a disk-cached request). Clear it once so those entries do not linger.
    static func purgeLegacyCache(defaults: UserDefaults = .standard) {
        let key = "onto.legacyArtCachePurged"
        guard !defaults.bool(forKey: key) else { return }
        URLCache.shared.removeAllCachedResponses()
        // The old iOS loader made its own cache at the default location; open it the same way to empty it.
        URLCache(memoryCapacity: 0, diskCapacity: 64 * 1024 * 1024).removeAllCachedResponses()
        defaults.set(true, forKey: key)
    }

    static func image(_ url: URL?) async -> UIImage? {
        guard let url else { return nil }
        if let cached = memory.object(forKey: url as NSURL) { return cached }
        let request = request(for: url, base: SettingsStore().base, token: KeychainToken.read())
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let image = UIImage(data: data) else { return nil }
            memory.setObject(image, forKey: url as NSURL, cost: data.count)
            return image
        } catch {
            return nil
        }
    }
}
