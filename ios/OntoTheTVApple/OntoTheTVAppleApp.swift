import SwiftUI

@main
struct OntoTheTVAppleApp: App {
    @State private var model = AppleModel()

    var body: some Scene {
        WindowGroup {
            AppleRoot(model: model)
        }
    }
}

struct AppleRoot: View {
    @Bindable var model: AppleModel

    var body: some View {
        ZStack {
            HomeScreen(model: model)
            if model.showSettings {
                SettingsScreen(model: model)
            }
        }
        .fullScreenCover(isPresented: $model.playing) {
            PlaybackScreen(model: model)
                .interactiveDismissDisabled(true)
        }
        .task { await model.loadHome() }
    }
}
