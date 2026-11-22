import SwiftUI

@main
struct OntoTheTVApp: App {
    @State private var model = RemoteModel()

    init() {
        ArtLoader.purgeLegacyCache()
    }

    var body: some Scene {
        WindowGroup {
            RemoteScreen(model: model)
        }
    }
}
