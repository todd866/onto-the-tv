import AVFoundation
import Foundation
import Observation

@MainActor
@Observable
final class AppleModel {
    var channels: [HomeChannel] = []
    var liked: [LikedTile] = []
    var playing = false
    var showSettings = false
    var notice: String?
    var fetching = false
    var error: String?
    var channelID = ""
    var serverDraft = ""
    var tokenDraft = ""
    var viewers: String?
    var people: [Person]
    var rating: String
    var tokenSet = false

    let player = AVPlayer()
    var viewerLabel: String { SettingsStore.viewerNames(viewers, people: people) }

    private let client: TVClient
    private let settings: SettingsStore
    private var rejected: Set<String> = []
    private var generation = 0
    private var current: NextItem?
    private var watched: Double = 0
    private var sample: (time: Double, at: Date)?
    private var statusObs: NSKeyValueObservation?

    init(client: TVClient? = nil, defaults: UserDefaults = .standard) {
        if let client {
            self.client = client
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 30
            config.timeoutIntervalForResource = 60
            config.requestCachePolicy = .reloadIgnoringLocalCacheData
            config.urlCache = nil
            self.client = TVClient(session: URLSession(configuration: config))
        }
        let settings = SettingsStore(defaults: defaults)
        self.settings = settings
        viewers = settings.viewers
        people = settings.people
        rating = settings.rating
        serverDraft = settings.base
        let interval = CMTime(seconds: 0.5, preferredTimescale: 600)
        player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
            Task { @MainActor in self?.sampleWatch(time.seconds) }
        }
        NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main) { [weak self] note in
            Task { @MainActor in self?.itemEnded(note.object as? AVPlayerItem) }
        }
        NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: nil, queue: .main) { [weak self] note in
            Task { @MainActor in self?.itemFailed(note.object as? AVPlayerItem) }
        }
    }

    func loadHome() async {
        do {
            let data = try await fetch { base, secret in
                try TVAPI.homeRequest(base: base, token: secret, viewers: self.viewers, rating: self.rating)
            }
            let home = try TVAPI.decodeHome(data)
            people = settings.remember(home.viewers)
            channels = home.channels.filter { $0.app != true && !$0.id.isEmpty }
            liked = TVAPI.likedTiles(in: home)
            error = nil
        } catch is CancellationError {
            return
        } catch let urlError as URLError where urlError.code == .cancelled {
            return
        } catch {
            self.error = TVAPI.line(for: error)
        }
    }

    func openSettings() {
        serverDraft = settings.base
        tokenDraft = ""
        viewers = settings.viewers
        people = settings.people
        rating = settings.rating
        tokenSet = !KeychainToken.read().isEmpty
        showSettings = true
    }

    func commitServer() {
        let trimmed = serverDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        settings.base = trimmed.isEmpty ? SettingsStore.defaultBase : trimmed
        serverDraft = settings.base
        let token = tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        if !token.isEmpty {
            KeychainToken.write(token)
            tokenDraft = ""
        }
        tokenSet = !KeychainToken.read().isEmpty
        Task { await loadHome() }
    }

    func toggleViewer(_ id: String) {
        var on = SettingsStore.selected(from: viewers, people: people)
        if on.contains(id) { on.remove(id) } else { on.insert(id) }
        viewers = SettingsStore.viewersString(on, people: people)
        settings.viewers = viewers
        Task { await loadHome() }
    }

    func setRating(_ value: String) {
        rating = ["G", "PG", "M"].contains(value) ? value : SettingsStore.defaultRating
        settings.rating = rating
        Task { await loadHome() }
    }

    func viewerOn(_ id: String) -> Bool {
        SettingsStore.selected(from: viewers, people: people).contains(id)
    }

    /// A bare URL: ArtLoader adds the token as a header, so it never lands in a URL or a cache key.
    func artURL(_ path: String?) -> URL? {
        TVAPI.artworkURL(base: settings.base, path: path)
    }

    func openChannel(_ channel: HomeChannel) {
        begin(channelID: channel.id)
        let generation = self.generation
        Task { await loadNext(generation: generation, advance: nil) }
    }

    func openLiked(_ tile: LikedTile) {
        begin(channelID: tile.channelID)
        let item = NextItem(src: tile.id, title: tile.title, show: "", duration: tile.duration, resume: tile.resume)
        apply(item, generation: generation)
    }

    func closePlayer() {
        generation += 1
        player.pause()
        player.replaceCurrentItem(with: nil)
        statusObs = nil
        current = nil
        notice = nil
        playing = false
    }

    private func begin(channelID: String) {
        generation += 1
        showSettings = false
        self.channelID = channelID
        rejected = []
        notice = nil
        current = nil
        watched = 0
        sample = nil
        playing = true
        player.replaceCurrentItem(with: nil)
    }

    private func loadNext(generation: Int, advance: NextAdvance?) async {
        guard generation == self.generation else { return }
        fetching = true
        defer { if generation == self.generation { fetching = false } }
        do {
            let data = try await fetch { base, secret in
                try TVAPI.nextRequest(
                    base: base,
                    token: secret,
                    channel: self.channelID,
                    viewers: self.viewers,
                    rating: self.rating,
                    advance: advance
                )
            }
            guard generation == self.generation else { return }
            apply(try TVAPI.decodeNext(data), generation: generation)
        } catch is CancellationError {
            return
        } catch {
            guard generation == self.generation else { return }
            notice = TVAPI.line(for: error)
        }
    }

    private func apply(_ item: NextItem, generation: Int) {
        guard generation == self.generation else { return }
        let (step, nextRejected) = ChannelPlayback.step(item: item, rejected: rejected)
        rejected = nextRejected
        switch step {
        case .play(let src, let resume):
            notice = nil
            current = item
            watched = 0
            sample = nil
            start(src: src, resume: resume, generation: generation)
        case .skip(let line, let advance):
            notice = line
            current = nil
            player.replaceCurrentItem(with: nil)
            Task { await loadNext(generation: generation, advance: advance) }
        case .hold(let line):
            notice = line
            player.pause()
        case .idle:
            notice = nil
            playing = false
        }
    }

    private func start(src: String, resume: Double, generation: Int) {
        guard let url = try? TVAPI.mediaURL(base: settings.base, token: KeychainToken.read(), src: src) else {
            notice = "bad server"
            return
        }
        let item = AVPlayerItem(url: url)
        statusObs = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            guard item.status == .failed else { return }
            Task { @MainActor in self?.itemFailed(item) }
        }
        player.replaceCurrentItem(with: item)
        guard resume > 1 else {
            player.play()
            return
        }
        player.seek(to: CMTime(seconds: resume, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            Task { @MainActor in
                guard generation == self?.generation else { return }
                self?.player.play()
            }
        }
    }

    private func itemEnded(_ item: AVPlayerItem?) {
        guard let item, item == player.currentItem, let current else { return }
        self.current = nil
        let time = item.currentTime().seconds
        let mediaDuration = item.duration.seconds
        let advance = ChannelPlayback.endedAdvance(
            item: current,
            time: time.isFinite ? time : 0,
            watched: watched,
            mediaDuration: mediaDuration.isFinite ? mediaDuration : 0
        )
        guard !channelID.isEmpty else {
            playing = false
            return
        }
        let generation = self.generation
        let duration = current.duration > 0 ? current.duration : (mediaDuration.isFinite ? mediaDuration : 0)
        Task {
            await recordCompletion(src: current.src, duration: duration)
            await loadNext(generation: generation, advance: advance)
        }
    }

    private func itemFailed(_ item: AVPlayerItem?) {
        guard let item, item == player.currentItem, let current else { return }
        self.current = nil
        let (step, nextRejected) = ChannelPlayback.step(item: current, rejected: rejected, failed: true)
        rejected = nextRejected
        switch step {
        case .skip(let line, let advance):
            notice = line
            player.replaceCurrentItem(with: nil)
            let generation = self.generation
            Task { await loadNext(generation: generation, advance: advance) }
        case .hold(let line):
            notice = line
            player.pause()
        case .play, .idle:
            break
        }
    }

    private func recordCompletion(src: String, duration: Double) async {
        do {
            _ = try await fetch { base, secret in
                try TVAPI.progressRequest(
                    base: base,
                    token: secret,
                    src: src,
                    positionSeconds: 0,
                    durationSeconds: duration,
                    completed: true
                )
            }
        } catch {
            // The channel still asks for the next item. The Samsung app does not wait on this post.
        }
    }

    private func sampleWatch(_ time: Double) {
        guard time.isFinite, player.timeControlStatus == .playing else {
            sample = nil
            return
        }
        if let sample, time > sample.time {
            let wall = Date().timeIntervalSince(sample.at)
            watched += min(time - sample.time, wall + 0.25)
        }
        sample = (time, Date())
    }

    private func fetch(_ make: (String, String) throws -> TVRequest) async throws -> Data {
        let request = try make(settings.base, KeychainToken.read())
        let (data, status) = try await client.perform(request)
        if let message = TVAPI.serverMessage(status: status, data: data) {
            throw TVProblem(line: message)
        }
        return data
    }
}
