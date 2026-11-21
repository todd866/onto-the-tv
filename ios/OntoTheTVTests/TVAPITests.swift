import XCTest
@testable import OntoTheTV

final class TVAPITests: XCTestCase {
    func testEncodeURIComponentMatchesFred() {
        XCTAssertEqual(TVAPI.encodeURIComponent("rc car"), "rc%20car")
        XCTAssertEqual(TVAPI.encodeURIComponent("jake,mum,dad"), "jake%2Cmum%2Cdad")
        XCTAssertEqual(TVAPI.encodeURIComponent("mum & dad"), "mum%20%26%20dad")
        XCTAssertEqual(
            TVAPI.encodeURIComponent("Bluey/Keepy Uppy [1080p].mp4"),
            "Bluey%2FKeepy%20Uppy%20%5B1080p%5D.mp4"
        )
    }

    func testDefaultAudienceMatchesFred() {
        XCTAssertEqual(SettingsStore.defaultBase, "http://m2:8686")
        XCTAssertEqual(SettingsStore.defaultViewers, "jake,mum,dad")
        XCTAssertEqual(SettingsStore.defaultRating, "PG")
        XCTAssertEqual(SettingsStore.viewersString(["dad", "jake", "mum"]), "jake,mum,dad")
    }

    func testSearchAndHomeRequests() throws {
        let search = try TVAPI.searchRequest(
            base: "http://m2:8686",
            token: "sekrit",
            query: "  rc car  ",
            viewers: "jake,mum,dad",
            rating: "PG"
        )
        XCTAssertEqual(search.method, "GET")
        XCTAssertEqual(
            search.url.absoluteString,
            "http://m2:8686/api/search?q=rc%20car&viewers=jake%2Cmum%2Cdad&rating=PG"
        )
        XCTAssertEqual(search.headers["X-Onto-Token"], "sekrit")
        XCTAssertEqual(search.headers["Content-Type"], "application/json")
        XCTAssertNil(search.body)

        let long = "  " + String(repeating: "a", count: 100) + "  "
        let capped = try TVAPI.searchRequest(base: "http://m2:8686/", token: "t", query: long, viewers: "jake", rating: "G")
        XCTAssertTrue(capped.url.absoluteString.contains("q=" + String(repeating: "a", count: 80)))
        XCTAssertFalse(capped.url.absoluteString.contains(String(repeating: "a", count: 81)))

        let home = try TVAPI.homeRequest(base: "http://m2:8686", token: "sekrit", viewers: "jake,mum,dad", rating: "PG")
        XCTAssertEqual(home.url.absoluteString, "http://m2:8686/api/home?viewers=jake%2Cmum%2Cdad&rating=PG")
        XCTAssertEqual(try TVAPI.nowPlayingRequest(base: "http://m2:8686", token: "t").url.absoluteString, "http://m2:8686/api/now-playing")
        XCTAssertEqual(try TVAPI.diagnosticsRequest(base: "http://m2:8686", token: "t").url.absoluteString, "http://m2:8686/api/diagnostics")
        XCTAssertThrowsError(try TVAPI.homeRequest(base: "m2:8686", token: "t", viewers: "jake", rating: "PG"))
    }

    func testCommandBodiesMatchFred() throws {
        let bare: [TVCommand] = [.reload, .pause, .resume, .home]
        let names = ["reload", "pause", "resume", "home"]
        for (command, name) in zip(bare, names) {
            let body = try commandBody(command)
            XCTAssertEqual(Set(body.keys), ["action", "session"])
            XCTAssertEqual(body["action"] as? String, name)
            XCTAssertEqual(body["session"] as? String, "tv-live")
        }

        let tune = try commandBody(.tune(channel: "bluey"))
        XCTAssertEqual(Set(tune.keys), ["action", "session", "channel"])
        XCTAssertEqual(tune["action"] as? String, "tune")
        XCTAssertEqual(tune["channel"] as? String, "bluey")

        let play = try commandBody(.play(src: "Bluey/a.mp4", positionSeconds: 0))
        XCTAssertEqual(Set(play.keys), ["action", "session", "src", "positionSeconds"])
        XCTAssertEqual(play["src"] as? String, "Bluey/a.mp4")
        XCTAssertEqual(number(play, "positionSeconds"), 0)

        let request = try TVAPI.commandRequest(base: "http://m2:8686/", token: "sekrit", session: "tv-live", command: .pause)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.absoluteString, "http://m2:8686/api/tv-command")
        XCTAssertEqual(request.headers["X-Onto-Token"], "sekrit")
    }

    func testClientSendsTokenHeader() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CaptureProtocol.self]
        let client = TVClient(session: URLSession(configuration: config))
        let request = try TVAPI.commandRequest(base: "http://m2:8686", token: "sekrit", session: "tv-live", command: .home)
        let (_, status) = try await client.perform(request)
        XCTAssertEqual(status, 202)
        XCTAssertEqual(CaptureProtocol.last?.httpMethod, "POST")
        XCTAssertEqual(CaptureProtocol.last?.value(forHTTPHeaderField: "X-Onto-Token"), "sekrit")
        XCTAssertEqual(CaptureProtocol.last?.value(forHTTPHeaderField: "Content-Type"), "application/json")
    }

    func testLiveSessionUsesLastEventLikeFred() throws {
        let live = try TVAPI.decodeDiagnostics(fixture("diagnostics"))
        XCTAssertEqual(TVAPI.liveSession(in: live), "tv-live")

        let stale = try TVAPI.decodeDiagnostics(fixture("diagnostics-stale"))
        XCTAssertNil(TVAPI.liveSession(in: stale), "a fresh heartbeat session does not override a stale last event")

        XCTAssertEqual(try liveSession(age: 90_000), "tv-live")
        XCTAssertNil(try liveSession(age: 90_001))
        XCTAssertEqual(try liveSession(age: nil), "tv-live")
        let empty = try TVAPI.decodeDiagnostics(JSONSerialization.data(withJSONObject: ["events": []]))
        XCTAssertNil(TVAPI.liveSession(in: empty))
        let nameless = try TVAPI.decodeDiagnostics(JSONSerialization.data(withJSONObject: ["events": [["event": "playing", "ageMs": 10]]]))
        XCTAssertNil(TVAPI.liveSession(in: nameless))
    }

    func testHomeFixtureDecodesAndDropsAppChannels() throws {
        let home = try TVAPI.decodeHome(fixture("home"))
        XCTAssertEqual(home.ceiling, "PG")
        XCTAssertEqual(home.rating, "PG")
        XCTAssertEqual(home.viewers.map(\.id), ["sam", "jake", "mum", "dad"])
        XCTAssertEqual(home.viewers.map(\.on), [false, true, true, true])
        XCTAssertEqual(home.channels[0].now?.art, "/art?src=Bluey%2Fa.mp4")
        XCTAssertEqual(home.channels[0].now?.show, "Bluey")
        XCTAssertEqual(home.channels[0].now?.minutes, 7)
        XCTAssertEqual(home.channels[0].now?.next?.title, "Hospital")
        let tiles = TVAPI.channelTiles(in: home)
        XCTAssertEqual(tiles.map(\.id), ["cartoons", "bluey"])
        XCTAssertEqual(tiles[0].name, "Cartoons")
        XCTAssertEqual(
            TVAPI.artworkURL(base: "http://m2:8686/", path: tiles[0].artPath)?.absoluteString,
            "http://m2:8686/art?src=Bluey%2Fa.mp4"
        )
        XCTAssertNil(TVAPI.artworkURL(base: "http://m2:8686", path: ""))
        XCTAssertEqual(
            TVAPI.artworkURL(base: "http://m2:8686", path: "http://m2:8686/art?src=Bluey%2Fa.mp4")?.absoluteString,
            "http://m2:8686/art?src=Bluey%2Fa.mp4"
        )
    }

    func testSearchFixtureAndPlayBody() throws {
        let search = try TVAPI.decodeSearch(fixture("search"))
        XCTAssertEqual(search.suggestions, ["Grian"])
        XCTAssertEqual(search.cards[0].src, "Grian/e2.mp4")
        XCTAssertEqual(search.cards[0].title, "Hermitcraft S01E02 RC car jump")
        XCTAssertEqual(search.cards[0].creator, "Grian")
        XCTAssertEqual(search.cards[0].show, "Grian")
        XCTAssertEqual(search.cards[0].duration, 900)
        XCTAssertEqual(search.cards[0].art, "/art?src=Grian%2Fe2.mp4")
        XCTAssertEqual(search.cards[0].resume, 0)
        XCTAssertFalse(search.cards[0].watched)
        XCTAssertEqual(search.cards[1].resume, 200)
        let body = try commandBody(.play(src: search.cards[1].src, positionSeconds: search.cards[1].resume))
        XCTAssertEqual(body["action"] as? String, "play")
        XCTAssertEqual(body["src"] as? String, "Bluey/a.mp4")
        XCTAssertEqual(number(body, "positionSeconds"), 200)
        XCTAssertEqual(body["session"] as? String, "tv-live")
    }

    func testNowPlayingPresentation() throws {
        let now = try TVAPI.decodeNowPlaying(fixture("now-playing"))
        XCTAssertEqual(now.position, 12)
        XCTAssertEqual(now.channel?.id, "bluey")
        XCTAssertEqual(now.channel?.number, 3)
        XCTAssertEqual(now.profile, "jake")
        let shown = TVAPI.presentation(of: now)
        XCTAssertEqual(shown.title, "Keepy Uppy")
        XCTAssertEqual(shown.channel, "Bluey")
        XCTAssertEqual(shown.artPath, "/art?src=" + TVAPI.encodeURIComponent("Bluey/Keepy Uppy [1080p].mp4"))

        let idle = try TVAPI.decodeNowPlaying(fixture("now-playing-idle"))
        XCTAssertNil(idle.src)
        XCTAssertEqual(idle.position, 0)
        XCTAssertNil(idle.channel)
        let quiet = TVAPI.presentation(of: idle)
        XCTAssertEqual(quiet.title, "")
        XCTAssertEqual(quiet.channel, "")
        XCTAssertNil(quiet.artPath)

        let folder = NowPlaying(src: "Shows/Episode Name.mp4", position: 0, channel: nil, profile: nil)
        XCTAssertEqual(TVAPI.presentation(of: folder).title, "Episode Name")
        XCTAssertEqual(TVAPI.presentation(of: folder).channel, "Shows")
        let bare = NowPlaying(src: "Episode.mp4", position: 1, channel: nil, profile: nil)
        XCTAssertEqual(TVAPI.presentation(of: bare).title, "Episode")
        XCTAssertEqual(TVAPI.presentation(of: bare).channel, "")
    }

    func testServerErrorLine() throws {
        XCTAssertEqual(TVAPI.serverMessage(status: 409, data: try fixture("command-error")), "TV command already pending.")
        let accepted = try JSONSerialization.data(withJSONObject: [
            "id": "1", "session": "tv-live", "action": "pause", "createdAt": 1, "expiresAt": 2, "result": NSNull(),
        ])
        XCTAssertNil(TVAPI.serverMessage(status: 202, data: accepted))
        XCTAssertEqual(TVAPI.serverMessage(status: 500, data: Data()), "no answer")
        XCTAssertEqual(TVAPI.line(for: TVProblem(line: "TV off")), "TV off")
        XCTAssertEqual(TVAPI.line(for: URLError(.timedOut)), "no answer")
    }

    private func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle(for: TVAPITests.self).url(forResource: name, withExtension: "json"))
        return try Data(contentsOf: url)
    }

    private func number(_ body: [String: Any], _ key: String) -> Double? {
        (body[key] as? NSNumber)?.doubleValue
    }

    private func commandBody(_ command: TVCommand) throws -> [String: Any] {
        let request = try TVAPI.commandRequest(base: "http://m2:8686", token: "t", session: "tv-live", command: command)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: Any])
    }

    private func liveSession(age: Double?) throws -> String? {
        var event: [String: Any] = ["session": "tv-live", "event": "playing"]
        if let age { event["ageMs"] = age }
        let data = try JSONSerialization.data(withJSONObject: ["events": [event]])
        return TVAPI.liveSession(in: try TVAPI.decodeDiagnostics(data))
    }
}

private final class CaptureProtocol: URLProtocol {
    static var last: URLRequest?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.last = request
        let response = HTTPURLResponse(url: request.url!, statusCode: 202, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
