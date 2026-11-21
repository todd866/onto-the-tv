import Foundation

/// A problem the remote can show on the one-line error strip.
struct TVProblem: Error, Equatable {
    var line: String
}

struct TVRequest: Equatable {
    var method: String
    var url: URL
    var headers: [String: String]
    var body: Data?
}

enum TVCommand: Equatable {
    case reload
    case tune(channel: String)
    case play(src: String, positionSeconds: Double)
    case pause
    case resume
    case home
}

struct DiagnosticsSnapshot: Decodable, Equatable {
    var events: [DiagnosticEvent]
}

struct DiagnosticEvent: Decodable, Equatable {
    var session: String?
    var ageMs: Double?
}

struct HomeLineup: Decodable, Equatable {
    var ceiling: String?
    var defaultCeiling: String?
    var rating: String?
    var viewers: [HomeViewer]
    var channels: [HomeChannel]
}

struct HomeViewer: Decodable, Equatable {
    var id: String
    var name: String
    var on: Bool
}

struct HomeChannel: Decodable, Equatable {
    var id: String
    var number: Int
    var name: String
    var count: Int
    var about: String?
    var app: Bool?
    var now: HomeNow?
}

struct HomeNow: Decodable, Equatable {
    var show: String
    var title: String
    var minutes: Int
    var art: String
    var next: HomeNext?
}

struct HomeNext: Decodable, Equatable {
    var show: String
    var title: String
}

struct SearchResult: Decodable, Equatable {
    var cards: [SearchCard]
    var suggestions: [String]
}

struct SearchCard: Decodable, Equatable {
    var src: String
    var title: String
    var show: String
    var creator: String
    var duration: Double
    var art: String
    var resume: Double
    var watched: Bool
}

struct NowPlaying: Decodable, Equatable {
    var src: String?
    var position: Double
    var channel: NowChannel?
    var profile: String?
}

struct NowChannel: Decodable, Equatable {
    var id: String
    var number: Int?
    var name: String
}

struct NowPresentation: Equatable {
    var title: String
    var channel: String
    var artPath: String?
}

struct ChannelTile: Identifiable, Equatable {
    var id: String
    var name: String
    var artPath: String?
    var about: String
}

struct VideoTile: Identifiable, Equatable {
    var id: String
    var src: String
    var title: String
    var artPath: String
    var resume: Double
    var creator: String
}

enum TVAPI {
    /// Same unreserved set as `encodeURIComponent` in src/fred-mcp.js.
    static func encodeURIComponent(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.!~*'()")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    static func headers(token: String) -> [String: String] {
        ["X-Onto-Token": token, "Content-Type": "application/json"]
    }

    static func url(base: String, path: String) throws -> URL {
        var root = base.trimmingCharacters(in: .whitespacesAndNewlines)
        while root.hasSuffix("/") { root.removeLast() }
        guard let baseURL = URL(string: root),
              let scheme = baseURL.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              baseURL.host != nil,
              let url = URL(string: root + path) else {
            throw TVProblem(line: "bad server")
        }
        return url
    }

    static func searchRequest(base: String, token: String, query: String, viewers: String, rating: String) throws -> TVRequest {
        let q = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
        let path = "/api/search?q=\(encodeURIComponent(q))&viewers=\(encodeURIComponent(viewers))&rating=\(encodeURIComponent(rating))"
        return TVRequest(method: "GET", url: try url(base: base, path: path), headers: headers(token: token), body: nil)
    }

    static func homeRequest(base: String, token: String, viewers: String, rating: String) throws -> TVRequest {
        let path = "/api/home?viewers=\(encodeURIComponent(viewers))&rating=\(encodeURIComponent(rating))"
        return TVRequest(method: "GET", url: try url(base: base, path: path), headers: headers(token: token), body: nil)
    }

    static func nowPlayingRequest(base: String, token: String) throws -> TVRequest {
        TVRequest(method: "GET", url: try url(base: base, path: "/api/now-playing"), headers: headers(token: token), body: nil)
    }

    static func diagnosticsRequest(base: String, token: String) throws -> TVRequest {
        TVRequest(method: "GET", url: try url(base: base, path: "/api/diagnostics"), headers: headers(token: token), body: nil)
    }

    static func commandRequest(base: String, token: String, session: String, command: TVCommand) throws -> TVRequest {
        var payload: [String: Any] = ["session": session]
        switch command {
        case .reload:
            payload["action"] = "reload"
        case .tune(let channel):
            payload["action"] = "tune"
            payload["channel"] = channel
        case .play(let src, let positionSeconds):
            payload["action"] = "play"
            payload["src"] = src
            payload["positionSeconds"] = positionSeconds
        case .pause:
            payload["action"] = "pause"
        case .resume:
            payload["action"] = "resume"
        case .home:
            payload["action"] = "home"
        }
        let body = try JSONSerialization.data(withJSONObject: payload)
        return TVRequest(method: "POST", url: try url(base: base, path: "/api/tv-command"), headers: headers(token: token), body: body)
    }

    /// Fred uses the last diagnostics event, not the session list. A heartbeat keeps a session fresh
    /// without appending an event, so a stale last event means the TV is off.
    static func liveSession(in snapshot: DiagnosticsSnapshot) -> String? {
        guard let last = snapshot.events.last, let session = last.session, !session.isEmpty else { return nil }
        if let age = last.ageMs, age > 90_000 { return nil }
        return session
    }

    static func decodeDiagnostics(_ data: Data) throws -> DiagnosticsSnapshot {
        try JSONDecoder().decode(DiagnosticsSnapshot.self, from: data)
    }

    static func decodeHome(_ data: Data) throws -> HomeLineup {
        try JSONDecoder().decode(HomeLineup.self, from: data)
    }

    static func decodeSearch(_ data: Data) throws -> SearchResult {
        try JSONDecoder().decode(SearchResult.self, from: data)
    }

    static func decodeNowPlaying(_ data: Data) throws -> NowPlaying {
        try JSONDecoder().decode(NowPlaying.self, from: data)
    }

    static func serverMessage(status: Int, data: Data) -> String? {
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let error = object["error"] as? String, !error.isEmpty {
            return error
        }
        if !(200..<300).contains(status) { return "no answer" }
        return nil
    }

    static func line(for error: Error) -> String {
        if let problem = error as? TVProblem { return problem.line }
        if error is DecodingError { return "bad reply" }
        return "no answer"
    }

    static func channelTiles(in home: HomeLineup) -> [ChannelTile] {
        home.channels.compactMap { channel in
            guard !channel.id.isEmpty, channel.app != true else { return nil }
            let art = channel.now?.art ?? ""
            return ChannelTile(id: channel.id, name: channel.name, artPath: art.isEmpty ? nil : art, about: channel.about ?? "")
        }
    }

    static func videoTiles(in search: SearchResult) -> [VideoTile] {
        search.cards.map { card in
            VideoTile(id: card.src, src: card.src, title: card.title, artPath: card.art, resume: card.resume, creator: card.creator)
        }
    }

    /// Title the way Fred speaks a path: file name, extension off, trailing [bracket] off.
    /// Channel name comes from the now-playing channel, otherwise the first folder.
    static func presentation(of now: NowPlaying) -> NowPresentation {
        guard let src = now.src, !src.isEmpty else {
            return NowPresentation(title: "", channel: "", artPath: nil)
        }
        let parts = src.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        var title = parts.last ?? src
        if let dot = title.lastIndex(of: "."), dot != title.startIndex {
            title = String(title[..<dot])
        }
        if let range = title.range(of: #"\s*\[[^\]]+\]\s*$"#, options: .regularExpression) {
            title.removeSubrange(range)
        }
        let named = now.channel?.name.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let folder = parts.count > 1 ? parts[0] : ""
        let channel = named.isEmpty ? folder : named
        return NowPresentation(title: title, channel: channel, artPath: "/art?src=" + encodeURIComponent(src))
    }

    static func artworkURL(base: String, path: String?) -> URL? {
        guard let path, !path.isEmpty else { return nil }
        if path.hasPrefix("http://") || path.hasPrefix("https://") { return URL(string: path) }
        var root = base.trimmingCharacters(in: .whitespacesAndNewlines)
        while root.hasSuffix("/") { root.removeLast() }
        let suffix = path.hasPrefix("/") ? path : "/" + path
        return URL(string: root + suffix)
    }
}
