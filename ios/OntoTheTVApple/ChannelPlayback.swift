import Foundation

enum PlaybackStep: Equatable {
    case play(src: String, resume: Double)
    case skip(line: String, advance: NextAdvance)
    case hold(line: String)
    case idle
}

/// What this Apple TV will actually open, and the `/api/next` body the Samsung app sends.
enum ChannelPlayback {
    static let unsupportedLine = "can't play on Apple TV yet"
    /// Stop asking after this many different files AVPlayer cannot open, so a channel of MKV does not spin.
    static let unplayableLimit = 8

    /// Containers AVPlayer opens. The server also streams mkv, webm, avi, ts and m2ts unchanged.
    private static let playableExtensions: Set<String> = ["mp4", "m4v", "mov", "m3u8"]

    static func canPlay(src: String) -> Bool {
        playableExtensions.contains(fileExtension(of: src))
    }

    static func endedAdvance(item: NextItem, time: Double, watched: Double, mediaDuration: Double) -> NextAdvance {
        let duration = item.duration > 0 ? item.duration : mediaDuration
        return NextAdvance(
            current: item.src,
            reason: "ended",
            time: whole(time),
            watched: whole(max(0, watched)),
            duration: whole(duration)
        )
    }

    /// `failed` is an AVPlayer error on a container we were willing to open (the codec inside it).
    static func step(item: NextItem, rejected: Set<String>, failed: Bool = false) -> (PlaybackStep, Set<String>) {
        if item.src.isEmpty { return (.idle, rejected) }
        let blocked = failed || !canPlay(src: item.src)
        if !blocked { return (.play(src: item.src, resume: item.resume), []) }
        if rejected.contains(item.src) || rejected.count + 1 >= unplayableLimit {
            return (.hold(line: unsupportedLine), rejected)
        }
        var next = rejected
        next.insert(item.src)
        let advance = NextAdvance(current: item.src, reason: "error", time: 0, watched: 0, duration: whole(item.duration))
        return (.skip(line: unsupportedLine, advance: advance), next)
    }

    private static func fileExtension(of src: String) -> String {
        let name = src.split(separator: "/").last.map(String.init) ?? src
        let base = name.split(separator: "?").first.map(String.init) ?? name
        guard let dot = base.lastIndex(of: "."), dot != base.startIndex else { return "" }
        return base[base.index(after: dot)...].lowercased()
    }

    private static func whole(_ value: Double) -> Int {
        guard value.isFinite, value > 0 else { return 0 }
        return Int(value.rounded(.down))
    }
}
