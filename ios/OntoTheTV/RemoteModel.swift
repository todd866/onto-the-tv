import Foundation
import Observation

@MainActor
@Observable
final class RemoteModel {
    var title = ""
    var channel = ""
    var artURL: URL?
    var hasProgram = false
    var paused = false
    var channels: [ChannelTile] = []
    var results: [VideoTile] = []
    var showingResults = false
    var query = ""
    var error: String?
    var showSettings = false
    var listening = false
    var serverDraft = ""
    var tokenDraft = ""
    var viewers: String?
    var people: [Person]
    var rating: String
    var tokenSet = false
    var revision = 0

    var showsPause: Bool { hasProgram && !paused }
    var viewerLabel: String { SettingsStore.viewerNames(viewers, people: people) }

    private let client: TVClient
    private let settings: SettingsStore
    private let dictation = Dictation()
    private var poll: Task<Void, Never>?
    private var currentSrc = ""
    private var errorToken = 0

    init(client: TVClient = TVClient(), defaults: UserDefaults = .standard) {
        self.client = client
        let settings = SettingsStore(defaults: defaults)
        self.settings = settings
        viewers = settings.viewers
        people = settings.people
        rating = settings.rating
        serverDraft = settings.base
    }

    func foreground() {
        if poll == nil {
            poll = Task { [weak self] in
                while !Task.isCancelled {
                    let start = ContinuousClock.now
                    await self?.refreshNow()
                    if Task.isCancelled { return }
                    let rest = Duration.seconds(5) - start.duration(to: .now)
                    if rest > .zero { try? await Task.sleep(for: rest) }
                }
            }
        }
        Task {
            await refreshNow()
            await reloadLineup()
        }
    }

    func background() {
        poll?.cancel()
        poll = nil
        dictation.stop()
        listening = false
    }

    func togglePlay() async {
        await send(showsPause ? .pause : .resume)
    }

    func home() async { await send(.home) }

    func tune(_ tile: ChannelTile) async { await send(.tune(channel: tile.id)) }

    func play(_ tile: VideoTile) async {
        await send(.play(src: tile.src, positionSeconds: tile.resume))
    }

    func submitSearch() async {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        let token = errorToken
        do {
            let data = try await fetch { base, secret in
                try TVAPI.searchRequest(base: base, token: secret, query: q, viewers: self.viewers, rating: self.rating)
            }
            results = TVAPI.videoTiles(in: try TVAPI.decodeSearch(data))
            showingResults = true
            revision += 1
            if errorToken == token { error = nil }
        } catch {
            fail(TVAPI.line(for: error))
        }
    }

    func clearResults() {
        showingResults = false
    }

    func toggleMic() {
        if listening {
            dictation.stop()
            listening = false
            return
        }
        listening = true
        dictation.start(
            text: { [weak self] value in self?.query = value },
            failure: { [weak self] line in self?.fail(line) },
            ended: { [weak self] in self?.listening = false }
        )
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
        revision += 1
    }

    func toggleViewer(_ id: String) {
        var on = SettingsStore.selected(from: viewers, people: people)
        if on.contains(id) { on.remove(id) } else { on.insert(id) }
        viewers = SettingsStore.viewersString(on, people: people)
        settings.viewers = viewers
        Task { await reloadForAudience() }
    }

    func setRating(_ value: String) {
        rating = ["G", "PG", "M"].contains(value) ? value : SettingsStore.defaultRating
        settings.rating = rating
        Task { await reloadForAudience() }
    }

    func viewerOn(_ id: String) -> Bool {
        SettingsStore.selected(from: viewers, people: people).contains(id)
    }

    func reloadForAudience() async {
        await reloadLineup()
        if showingResults { await submitSearch() }
    }

    func artworkURL(_ path: String?) -> URL? {
        TVAPI.artworkURL(base: settings.base, path: path)
    }

    private func refreshNow() async {
        let token = errorToken
        do {
            let data = try await fetch { base, secret in
                try TVAPI.nowPlayingRequest(base: base, token: secret)
            }
            apply(try TVAPI.decodeNowPlaying(data))
            if errorToken == token { error = nil }
        } catch is CancellationError {
            return
        } catch let urlError as URLError where urlError.code == .cancelled {
            return
        } catch {
            fail(TVAPI.line(for: error))
        }
    }

    private func reloadLineup() async {
        let token = errorToken
        do {
            let data = try await fetch { base, secret in
                try TVAPI.homeRequest(base: base, token: secret, viewers: self.viewers, rating: self.rating)
            }
            let home = try TVAPI.decodeHome(data)
            people = settings.remember(home.viewers)
            channels = TVAPI.channelTiles(in: home)
            revision += 1
            if errorToken == token { error = nil }
        } catch is CancellationError {
            return
        } catch let urlError as URLError where urlError.code == .cancelled {
            return
        } catch {
            fail(TVAPI.line(for: error))
        }
    }

    private func send(_ command: TVCommand) async {
        let token = errorToken
        do {
            let data = try await fetch { base, secret in
                try TVAPI.diagnosticsRequest(base: base, token: secret)
            }
            guard let session = TVAPI.liveSession(in: try TVAPI.decodeDiagnostics(data)) else {
                throw TVProblem(line: "TV off")
            }
            _ = try await fetch { base, secret in
                try TVAPI.commandRequest(base: base, token: secret, session: session, command: command)
            }
            switch command {
            case .pause:
                paused = true
            case .resume, .play, .tune, .home, .reload:
                paused = false
            }
            if errorToken == token { error = nil }
            await refreshNow()
        } catch {
            fail(TVAPI.line(for: error))
        }
    }

    private func apply(_ now: NowPlaying) {
        let src = now.src ?? ""
        if src != currentSrc {
            currentSrc = src
            paused = false
        }
        let shown = TVAPI.presentation(of: now)
        title = shown.title
        channel = shown.channel
        artURL = TVAPI.artworkURL(base: settings.base, path: shown.artPath)
        hasProgram = !src.isEmpty
    }

    private func fetch(_ make: (String, String) throws -> TVRequest) async throws -> Data {
        let request = try make(settings.base, KeychainToken.read())
        let (data, status) = try await client.perform(request)
        if let message = TVAPI.serverMessage(status: status, data: data) {
            throw TVProblem(line: message)
        }
        return data
    }

    private func fail(_ line: String) {
        errorToken += 1
        error = line
    }
}
