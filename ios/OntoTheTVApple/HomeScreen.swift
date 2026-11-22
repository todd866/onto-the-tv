import SwiftUI
import UIKit

enum TVColor {
    static func canvas(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(white: 0.08) : Color(white: 0.96)
    }

    static func placeholder(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(white: 0.20) : Color(white: 0.84)
    }
}

enum HomeFocus: Hashable {
    case settings
    case channel(String)
    case liked(String)
}

struct PosterTile: View {
    var title: String
    var badge: String?
    var symbol: String?
    var imageURL: URL?
    @Environment(\.colorScheme) private var scheme
    @State private var image: UIImage?

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Rectangle().fill(TVColor.placeholder(scheme))
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            }
            HStack(spacing: 12) {
                mark
                    .frame(width: 56, alignment: .center)
                Text(title)
                    .font(.title2.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Spacer(minLength: 0)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .frame(height: 72)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.black.opacity(0.55))
        }
        .frame(width: 700, height: 394)
        .clipped()
        .task(id: imageURL) {
            image = nil
            image = await ArtLoader.image(imageURL)
        }
    }

    @ViewBuilder
    private var mark: some View {
        if let badge {
            Text(badge)
                .font(.title2.weight(.semibold).monospacedDigit())
        } else if let symbol {
            Image(systemName: symbol)
                .font(.title2)
                .accessibilityHidden(true)
        }
    }
}

struct HomeScreen: View {
    @Bindable var model: AppleModel
    @FocusState private var focus: HomeFocus?
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 36) {
            HStack {
                Spacer()
                Button {
                    model.openSettings()
                } label: {
                    Image(systemName: "gearshape")
                        .font(.title2)
                        .frame(width: 64, height: 64)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Settings")
                .focused($focus, equals: .settings)
            }
            .padding(.horizontal, 80)

            if !model.channels.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 40) {
                        ForEach(model.channels, id: \.id) { channel in
                            Button {
                                model.openChannel(channel)
                            } label: {
                                PosterTile(
                                    title: channel.name,
                                    badge: String(channel.number),
                                    imageURL: model.artURL(channel.now?.art)
                                )
                            }
                            .buttonStyle(.card)
                            .accessibilityLabel("\(channel.number) \(channel.name)")
                            .accessibilityHint(channel.about ?? "")
                            .focused($focus, equals: .channel(channel.id))
                        }
                    }
                    .padding(.horizontal, 80)
                    .padding(.vertical, 24)
                }
                .focusSection()
            }

            if !model.liked.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 40) {
                        ForEach(model.liked) { tile in
                            Button {
                                model.openLiked(tile)
                            } label: {
                                PosterTile(
                                    title: tile.title,
                                    symbol: "heart.fill",
                                    imageURL: model.artURL(tile.artPath)
                                )
                            }
                            .buttonStyle(.card)
                            .accessibilityLabel(tile.title)
                            .focused($focus, equals: .liked(tile.id))
                        }
                    }
                    .padding(.horizontal, 80)
                    .padding(.vertical, 24)
                }
                .focusSection()
            }

            Spacer(minLength: 0)

            if let error = model.error, !error.isEmpty {
                HStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.title2)
                        .accessibilityHidden(true)
                    Text(error)
                        .font(.title3)
                        .lineLimit(1)
                }
                .foregroundStyle(.red)
                .padding(.horizontal, 80)
                .padding(.bottom, 36)
            }
        }
        .padding(.top, 48)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(TVColor.canvas(scheme))
        .defaultFocus($focus, preferred)
        .onChange(of: model.playing) { _, isPlaying in
            guard !isPlaying else { return }
            focus = channelFocus
        }
        .onChange(of: model.channels.map(\.id)) { _, _ in
            guard !model.showSettings, model.channelID.isEmpty else { return }
            if focus == nil || focus == .settings { focus = channelFocus }
        }
    }

    private var preferred: HomeFocus {
        channelFocus ?? .settings
    }

    private var channelFocus: HomeFocus? {
        if model.channels.contains(where: { $0.id == model.channelID }) {
            return .channel(model.channelID)
        }
        if let first = model.channels.first { return .channel(first.id) }
        return nil
    }
}
