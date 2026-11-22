import UIKit
import SwiftUI
import XCTest
@testable import OntoTheTVApple

@MainActor
final class AppleScreenTests: XCTestCase {
    func testRenderHomeSettingsAndPlayback() throws {
        let suite = "ontotv-render-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        let model = AppleModel(defaults: defaults)
        model.channels = [
            HomeChannel(id: "cartoons", number: 1, name: "Cartoons", count: 3, about: "Cartoons — Bluey", app: nil,
                        now: HomeNow(show: "Bluey", title: "Keepy Uppy", minutes: 7, art: "", next: nil)),
            HomeChannel(id: "bluey", number: 2, name: "Bluey", count: 2, about: "Bluey", app: nil,
                        now: HomeNow(show: "Bluey", title: "Hospital", minutes: 7, art: "", next: nil)),
        ]
        model.liked = [
            LikedTile(id: "Bluey/a.mp4", title: "S1 E1 · Keepy Uppy", artPath: "", channelID: "bluey", resume: 0, duration: 420)
        ]
        model.serverDraft = "http://tv.local:8686"
        model.viewers = "kid2,adult1,adult2"
        model.rating = "PG"
        model.tokenSet = true

        try render(HomeScreen(model: model), name: "home-light", style: .light)
        try render(HomeScreen(model: model), name: "home-dark", style: .dark)
        try render(SettingsScreen(model: model), name: "settings-light", style: .light)
        try render(SettingsScreen(model: model), name: "settings-dark", style: .dark)

        model.notice = "can't play on Apple TV yet"
        try render(PlaybackScreen(model: model), name: "play-light", style: .light)
        try render(PlaybackScreen(model: model), name: "play-dark", style: .dark)
        defaults.removePersistentDomain(forName: suite)
    }

    private func render<V: View>(_ view: V, name: String, style: UIUserInterfaceStyle) throws {
        let scheme: ColorScheme = style == .dark ? .dark : .light
        let controller = UIHostingController(rootView: view.environment(\.colorScheme, scheme))
        controller.overrideUserInterfaceStyle = style
        let size = CGSize(width: 1920, height: 1080)
        controller.view.bounds = CGRect(origin: .zero, size: size)
        controller.view.frame = CGRect(origin: .zero, size: size)
        let window = UIWindow(frame: CGRect(origin: .zero, size: size))
        window.overrideUserInterfaceStyle = style
        window.rootViewController = controller
        window.isHidden = false
        window.layoutIfNeeded()
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true)
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ontotv-\(name).png")
        let data = try XCTUnwrap(image.pngData())
        try data.write(to: url)
        print("RENDER \(url.path) \(data.count)")
        XCTAssertGreaterThan(data.count, 8_000, name)
    }
}
