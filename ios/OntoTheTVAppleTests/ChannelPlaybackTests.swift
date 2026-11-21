import XCTest
@testable import OntoTheTVApple

final class ChannelPlaybackTests: XCTestCase {
    func testFirstTuneAsksForTheChannelWithoutACurrentItem() throws {
        let request = try TVAPI.nextRequest(
            base: "http://m2:8686/",
            token: "sekrit",
            channel: "bluey",
            viewers: "jake,mum,dad",
            rating: "PG",
            advance: nil
        )
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.absoluteString, "http://m2:8686/api/next")
        XCTAssertEqual(request.headers["X-Onto-Token"], "sekrit")
        XCTAssertEqual(request.headers["Content-Type"], "application/json")
        let body = try json(request)
        XCTAssertEqual(Set(body.keys), ["channel", "viewers", "rating"])
        XCTAssertEqual(body["channel"] as? String, "bluey")
        XCTAssertEqual(body["viewers"] as? String, "jake,mum,dad")
        XCTAssertEqual(body["rating"] as? String, "PG")
    }

    func testEndedTuneMatchesTheSamsungNextBody() throws {
        let item = try TVAPI.decodeNext(nextJSON(src: "Bluey/a.mp4", duration: 420.8, resume: 12))
        XCTAssertEqual(item.src, "Bluey/a.mp4")
        XCTAssertEqual(item.show, "Bluey")
        XCTAssertEqual(item.duration, 420.8)
        XCTAssertEqual(item.resume, 12)
        let advance = ChannelPlayback.endedAdvance(item: item, time: 420.2, watched: 400.9, mediaDuration: 419)
        XCTAssertEqual(
            advance,
            NextAdvance(current: "Bluey/a.mp4", reason: "ended", time: 420, watched: 400, duration: 420)
        )
        let body = try json(try TVAPI.nextRequest(
            base: "http://m2:8686",
            token: "sekrit",
            channel: "bluey",
            viewers: "jake,mum,dad",
            rating: "PG",
            advance: advance
        ))
        XCTAssertEqual(Set(body.keys), ["channel", "viewers", "rating", "current", "reason", "time", "watched", "duration"])
        XCTAssertEqual(body["reason"] as? String, "ended")
        XCTAssertEqual(body["current"] as? String, "Bluey/a.mp4")
        XCTAssertEqual(number(body, "time"), 420)
        XCTAssertEqual(number(body, "watched"), 400)
        XCTAssertEqual(number(body, "duration"), 420)
    }

    func testEndedDurationFallsBackToThePlayer() {
        let item = NextItem(src: "Bluey/a.mp4", title: "Keepy Uppy", show: "Bluey", duration: 0, resume: 0)
        let advance = ChannelPlayback.endedAdvance(item: item, time: 10.9, watched: 8.2, mediaDuration: 90.7)
        XCTAssertEqual(advance.duration, 90)
        XCTAssertEqual(advance.time, 10)
        XCTAssertEqual(advance.watched, 8)
    }

    func testEndedTuneRecordsCompletion() throws {
        let request = try TVAPI.progressRequest(
            base: "http://m2:8686",
            token: "sekrit",
            src: "Bluey/a.mp4",
            positionSeconds: 0,
            durationSeconds: 420.8,
            completed: true
        )
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.absoluteString, "http://m2:8686/api/progress")
        let body = try json(request)
        XCTAssertEqual(Set(body.keys), ["src", "positionSeconds", "durationSeconds", "completed"])
        XCTAssertEqual(body["src"] as? String, "Bluey/a.mp4")
        XCTAssertEqual(number(body, "positionSeconds"), 0)
        XCTAssertEqual(number(body, "durationSeconds"), 420.8)
        XCTAssertEqual(body["completed"] as? Bool, true)
    }

    func testMediaURLMatchesTheSamsungFileURL() throws {
        XCTAssertEqual(
            try TVAPI.mediaURL(base: "http://m2:8686/", token: "sekrit", src: "Bluey/Keepy Uppy [1080p].mp4").absoluteString,
            "http://m2:8686/media?src=Bluey%2FKeepy%20Uppy%20%5B1080p%5D.mp4&t=sekrit"
        )
        XCTAssertEqual(
            try TVAPI.mediaURL(base: "http://m2:8686", token: "", src: "Bluey/a.mp4").absoluteString,
            "http://m2:8686/media?src=Bluey%2Fa.mp4"
        )
    }

    func testMp4MovAndHlsPlayMkvWebmAviAndTransportStreamsDoNot() {
        let playable = [
            "Bluey/Keepy Uppy [1080p].mp4",
            "Film/A.MOV",
            "Film/A.m4v",
            "live/index.m3u8",
        ]
        let blocked = [
            "Show/Episode.mkv",
            "Show/Episode.MKV",
            "Show/Episode.webm",
            "Show/Episode.avi",
            "Show/Episode.ts",
            "Show/Episode.m2ts",
            "Show/NoExtension",
        ]
        for src in playable {
            XCTAssertTrue(ChannelPlayback.canPlay(src: src), src)
        }
        for src in blocked {
            XCTAssertFalse(ChannelPlayback.canPlay(src: src), src)
        }
    }

    func testUnplayableItemShowsTheAppleTVLineAndAsksForTheNext() {
        let item = NextItem(src: "Show/A.mkv", title: "A", show: "Show", duration: 100.4, resume: 0)
        let (step, rejected) = ChannelPlayback.step(item: item, rejected: [])
        guard case .skip(let line, let advance) = step else {
            return XCTFail("expected a skip, got \(step)")
        }
        XCTAssertEqual(line, "can't play on Apple TV yet")
        XCTAssertEqual(advance.reason, "error")
        XCTAssertEqual(advance.current, "Show/A.mkv")
        XCTAssertEqual(advance.time, 0)
        XCTAssertEqual(advance.watched, 0)
        XCTAssertEqual(advance.duration, 100)
        XCTAssertEqual(rejected, ["Show/A.mkv"])
    }

    func testAPlayableItemStartsAtItsResumePoint() {
        let item = NextItem(src: "Bluey/a.mp4", title: "Keepy Uppy", show: "Bluey", duration: 420, resume: 200)
        let (step, rejected) = ChannelPlayback.step(item: item, rejected: ["Show/A.mkv"])
        guard case .play(let src, let resume) = step else {
            return XCTFail("expected play, got \(step)")
        }
        XCTAssertEqual(src, "Bluey/a.mp4")
        XCTAssertEqual(resume, 200)
        XCTAssertTrue(rejected.isEmpty)
    }

    func testTheSameUnplayablePathStopsTheChannel() {
        let item = NextItem(src: "Show/A.mkv", title: "A", show: "Show", duration: 10, resume: 0)
        let (step, _) = ChannelPlayback.step(item: item, rejected: ["Show/A.mkv"])
        guard case .hold(let line) = step else {
            return XCTFail("expected hold, got \(step)")
        }
        XCTAssertEqual(line, "can't play on Apple TV yet")
    }

    func testEightUnplayableItemsStopTheChannel() {
        var rejected: Set<String> = []
        for index in 1...ChannelPlayback.unplayableLimit {
            let item = NextItem(src: "Show/\(index).mkv", title: "", show: "", duration: 1, resume: 0)
            let (step, next) = ChannelPlayback.step(item: item, rejected: rejected)
            rejected = next
            if index < ChannelPlayback.unplayableLimit {
                guard case .skip = step else { return XCTFail("item \(index) should skip, got \(step)") }
            } else {
                guard case .hold(let line) = step else { return XCTFail("item \(index) should hold, got \(step)") }
                XCTAssertEqual(line, "can't play on Apple TV yet")
            }
        }
    }

    func testPlayerFailureOnAPlayableContainerSkipsWithoutGradingItWatched() throws {
        let item = try TVAPI.decodeNext(nextJSON(src: "Show/Odd.mp4", duration: 50, resume: 0))
        let (step, _) = ChannelPlayback.step(item: item, rejected: [], failed: true)
        guard case .skip(let line, let advance) = step else {
            return XCTFail("expected a skip, got \(step)")
        }
        XCTAssertEqual(line, "can't play on Apple TV yet")
        XCTAssertEqual(advance.reason, "error")
        XCTAssertNotEqual(advance.reason, "ended")
        XCTAssertNotEqual(advance.reason, "skip")
    }

    func testEmptyNextDoesNotPlay() {
        let item = NextItem(src: "", title: "", show: "", duration: 0, resume: 0)
        let (step, _) = ChannelPlayback.step(item: item, rejected: [])
        guard case .idle = step else { return XCTFail("expected idle, got \(step)") }
    }

    func testHomeLikedRowFollowsTheChannels() throws {
        let home = try TVAPI.decodeHome("""
        {"ceiling":"PG","rating":"PG","viewers":[],"channels":[
          {"id":"cartoons","number":1,"name":"Cartoons","count":1,"about":"Cartoons"},
          {"id":"games","number":2,"name":"Games","count":1,"app":true,"about":"Games"}
        ],"liked":[{
          "src":"Bluey/a.mp4","title":"Bluey S01E01 Keepy Uppy","show":"Bluey","duration":420,"resume":0,
          "display":{"show":"Bluey","episode":"S1 E1 · Keepy Uppy"},
          "channel":{"id":"bluey","number":3,"name":"Bluey"}
        }]}
        """.data(using: .utf8)!)
        XCTAssertEqual(TVAPI.channelTiles(in: home).map(\.id), ["cartoons"])
        let liked = TVAPI.likedTiles(in: home)
        XCTAssertEqual(liked.map(\.id), ["Bluey/a.mp4"])
        XCTAssertEqual(liked[0].title, "S1 E1 · Keepy Uppy")
        XCTAssertEqual(liked[0].artPath, "/art?src=" + TVAPI.encodeURIComponent("Bluey/a.mp4"))
        XCTAssertEqual(liked[0].channelID, "bluey")
    }

    private func nextJSON(src: String, duration: Double, resume: Double) -> Data {
        """
        {"src":"\(src)","title":"Keepy Uppy","show":"Bluey","tier":"shared",
         "display":{"show":"Bluey","episode":"S1 E1 · Keepy Uppy"},
         "channels":["bluey"],"duration":\(duration),"resume":\(resume),"liked":false,
         "queue":[{"kind":"show","src":"\(src)","breaks":[]}]}
        """.data(using: .utf8)!
    }

    private func json(_ request: TVRequest) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: Any])
    }

    private func number(_ body: [String: Any], _ key: String) -> Double? {
        (body[key] as? NSNumber)?.doubleValue
    }
}
