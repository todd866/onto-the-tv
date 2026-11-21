import SwiftUI

@main
struct OntoTheTVApp: App {
    @State private var model = RemoteModel()

    var body: some Scene {
        WindowGroup {
            RemoteScreen(model: model)
        }
    }
}
