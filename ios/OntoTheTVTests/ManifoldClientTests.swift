import XCTest
@testable import OntoTheTV

final class ManifoldClientTests: XCTestCase {
    func testBundledLensesAndSettingsPersistence() throws {
        let suite = "ontotv-manifold-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let store = SettingsStore(defaults: defaults)
        XCTAssertEqual(store.manifoldLensID, "")
        XCTAssertEqual(ManifoldClient.bundledTVLenses.count, 3)

        store.manifoldLensID = "lens:tv:night-flight"
        XCTAssertEqual(SettingsStore(defaults: defaults).manifoldLensID, "lens:tv:night-flight")
    }
}
