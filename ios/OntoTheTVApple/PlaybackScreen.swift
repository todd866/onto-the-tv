import AVKit
import SwiftUI

struct PlaybackScreen: View {
    @Bindable var model: AppleModel

    var body: some View {
        PlayerHost(
            player: model.player,
            notice: model.notice ?? "",
            coverSpinner: model.notice != nil && !model.fetching,
            onMenu: { model.closePlayer() }
        )
        .ignoresSafeArea()
        .background(.black)
        .onExitCommand { model.closePlayer() }
    }
}

struct PlayerHost: UIViewControllerRepresentable {
    var player: AVPlayer
    var notice: String
    var coverSpinner: Bool
    var onMenu: () -> Void

    func makeUIViewController(context: Context) -> MenuPlayerController {
        let controller = MenuPlayerController()
        controller.player = player
        controller.showsPlaybackControls = true
        controller.onMenu = onMenu
        controller.setNotice(notice, coverSpinner: coverSpinner)
        return controller
    }

    func updateUIViewController(_ controller: MenuPlayerController, context: Context) {
        controller.player = player
        controller.onMenu = onMenu
        controller.setNotice(notice, coverSpinner: coverSpinner)
    }
}

final class MenuPlayerController: AVPlayerViewController {
    var onMenu: () -> Void = {}
    private let cover = UIView()
    private let label = UILabel()
    private var didInstallNotice = false

    func setNotice(_ text: String, coverSpinner: Bool) {
        installNotice()
        label.text = text
        label.isHidden = text.isEmpty
        cover.isHidden = text.isEmpty || !coverSpinner
        view.bringSubviewToFront(cover)
        view.bringSubviewToFront(label)
    }

    private func installNotice() {
        guard !didInstallNotice else { return }
        didInstallNotice = true
        cover.backgroundColor = .black
        cover.isUserInteractionEnabled = false
        cover.translatesAutoresizingMaskIntoConstraints = false
        label.textColor = .white
        label.textAlignment = .center
        label.font = .preferredFont(forTextStyle: .title2)
        label.numberOfLines = 1
        label.backgroundColor = UIColor.black.withAlphaComponent(0.72)
        label.isUserInteractionEnabled = false
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cover)
        view.addSubview(label)
        NSLayoutConstraint.activate([
            cover.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            cover.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            cover.topAnchor.constraint(equalTo: view.topAnchor),
            cover.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            label.topAnchor.constraint(equalTo: view.topAnchor),
            label.heightAnchor.constraint(equalToConstant: 96),
        ])
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard didInstallNotice else { return }
        view.bringSubviewToFront(cover)
        view.bringSubviewToFront(label)
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if presses.contains(where: { $0.type == .menu }) {
            onMenu()
            return
        }
        super.pressesBegan(presses, with: event)
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if presses.contains(where: { $0.type == .menu }) { return }
        super.pressesEnded(presses, with: event)
    }
}
