import SwiftUI

struct RemoteScreen: View {
    @Bindable var model: RemoteModel
    @Environment(\.scenePhase) private var scenePhase

    private let columns = [
        GridItem(.flexible(), spacing: 12, alignment: .top),
        GridItem(.flexible(), spacing: 12, alignment: .top),
    ]

    var body: some View {
        VStack(spacing: 0) {
            nowPlaying
            if let error = model.error {
                errorLine(error)
            }
            Divider()
            searchRow
            Divider()
            grid
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            transport
        }
        .background(Color(uiColor: .systemBackground))
        .sheet(isPresented: $model.showSettings, onDismiss: {
            model.commitServer()
            Task { await model.reloadForAudience() }
        }) {
            SettingsSheet(model: model)
                .presentationDetents([.height(332)])
                .presentationDragIndicator(.visible)
        }
        .onAppear {
            if scenePhase == .active { model.foreground() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.foreground() } else { model.background() }
        }
    }

    private var nowPlaying: some View {
        HStack(spacing: 12) {
            ArtThumb(url: model.artURL, revision: model.revision)
                .frame(width: 128, height: 72)
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .accessibilityHidden(true)
            if !model.title.isEmpty || !model.channel.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ClipText(text: model.title, font: .headline)
                    if !model.channel.isEmpty {
                        ClipText(text: model.channel, font: .subheadline, color: .secondary)
                    }
                }
            }
            Spacer(minLength: 0)
            SymbolButton(
                systemName: model.showsPause ? "pause.fill" : "play.fill",
                label: model.showsPause ? "Pause" : "Play",
                size: 26
            ) {
                Task { await model.togglePlay() }
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 96)
    }

    private func errorLine(_ message: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption)
                .accessibilityHidden(true)
            Text(message)
                .font(.caption)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .foregroundStyle(Color.alarm)
        .padding(.horizontal, 12)
        .frame(height: 20)
        .background(alignment: .bottom) {
            Rectangle().fill(Color.alarm).frame(height: 2)
        }
        .accessibilityLabel(message)
    }

    private var searchRow: some View {
        HStack(spacing: 4) {
            TextField("Search", text: $model.query)
                .textFieldStyle(.roundedBorder)
                .submitLabel(.search)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onSubmit { Task { await model.submitSearch() } }
            if model.showingResults {
                SymbolButton(systemName: "xmark", label: "Channels", size: 18) {
                    model.clearResults()
                }
            }
            SymbolButton(
                systemName: model.listening ? "stop.fill" : "mic.fill",
                label: model.listening ? "Stop" : "Dictate",
                size: 20,
                tint: model.listening ? .orange : .primary
            ) {
                model.toggleMic()
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 52)
    }

    private var grid: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 12) {
                if model.showingResults {
                    ForEach(model.results) { tile in
                        MediaTile(
                            name: tile.title,
                            art: model.artworkURL(tile.artPath),
                            revision: model.revision,
                            actionLabel: "Play \(tile.title)",
                            hint: tile.creator == tile.title ? "" : tile.creator
                        ) {
                            Task { await model.play(tile) }
                        }
                    }
                } else {
                    ForEach(model.channels) { tile in
                        MediaTile(
                            name: tile.name,
                            art: model.artworkURL(tile.artPath),
                            revision: model.revision,
                            actionLabel: "Tune \(tile.name)",
                            hint: tile.about
                        ) {
                            Task { await model.tune(tile) }
                        }
                    }
                }
            }
            .padding(12)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
    }

    private var transport: some View {
        HStack {
            SymbolButton(systemName: "house", label: "Home", size: 26) {
                Task { await model.home() }
            }
            Spacer()
            SymbolButton(
                systemName: model.showsPause ? "pause.fill" : "play.fill",
                label: model.showsPause ? "Pause" : "Play",
                size: 26
            ) {
                Task { await model.togglePlay() }
            }
            Spacer()
            SymbolButton(systemName: "gearshape", label: "Settings", size: 26) {
                model.openSettings()
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 64)
    }
}

private struct MediaTile: View {
    var name: String
    var art: URL?
    var revision: Int
    var actionLabel: String
    var hint: String
    var action: () -> Void

    var body: some View {
        VStack(spacing: 6) {
            Button(action: action) {
                ArtThumb(url: art, revision: revision)
                    .aspectRatio(16 / 9, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 4))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(actionLabel)
            .accessibilityHint(hint)
            ClipText(text: name, font: .subheadline, onPlainTap: action)
                .frame(maxWidth: .infinity)
        }
    }
}

struct SymbolButton: View {
    var systemName: String
    var label: String
    var size: CGFloat = 22
    var tint: Color = .primary
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: size))
                .foregroundStyle(tint)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// One line. A tap opens the full string only when the line is actually clipped.
struct ClipText: View {
    var text: String
    var font: Font = .headline
    var color: Color = .primary
    var onPlainTap: (() -> Void)?

    @State private var visibleWidth: CGFloat = 0
    @State private var fullWidth: CGFloat = 0
    @State private var show = false

    private var clipped: Bool { fullWidth > visibleWidth + 1 && visibleWidth > 0 }

    var body: some View {
        Text(text)
            .font(font)
            .foregroundStyle(color)
            .lineLimit(1)
            .truncationMode(.tail)
            .background {
                GeometryReader { geo in
                    Color.clear.preference(key: VisibleWidthKey.self, value: geo.size.width)
                }
            }
            .background {
                Text(text)
                    .font(font)
                    .fixedSize(horizontal: true, vertical: false)
                    .hidden()
                    .background {
                        GeometryReader { geo in
                            Color.clear.preference(key: FullWidthKey.self, value: geo.size.width)
                        }
                    }
            }
            .onPreferenceChange(VisibleWidthKey.self) { visibleWidth = $0 }
            .onPreferenceChange(FullWidthKey.self) { fullWidth = $0 }
            .contentShape(Rectangle())
            .onTapGesture {
                if clipped { show = true } else { onPlainTap?() }
            }
            .accessibilityHidden(text.isEmpty || (onPlainTap != nil && !clipped))
            .accessibilityAddTraits(clipped ? .isButton : [])
            .accessibilityHint(clipped ? "Full title" : "")
            .popover(isPresented: $show) {
                Text(text)
                    .font(.body)
                    .padding(16)
                    .frame(maxWidth: 320)
                    .presentationCompactAdaptation(.popover)
            }
    }
}

private struct VisibleWidthKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct FullWidthKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

extension Color {
    static let alarm = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 1, green: 0.38, blue: 0.32, alpha: 1)
            : UIColor(red: 0.62, green: 0.04, blue: 0.04, alpha: 1)
    })
}

struct SettingsSheet: View {
    @Bindable var model: RemoteModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                SymbolButton(systemName: "xmark", label: "Close", size: 18) {
                    dismiss()
                }
            }
            .padding(.horizontal, 4)
            serverRow
            Divider()
            tokenRow
            Divider()
            viewersRow
            Divider()
            ratingRow
            Spacer(minLength: 0)
        }
        .background(Color(uiColor: .systemBackground))
    }

    private var serverRow: some View {
        HStack(spacing: 8) {
            Text("Server")
                .frame(width: 76, alignment: .leading)
            TextField("Server", text: $model.serverDraft)
                .textFieldStyle(.roundedBorder)
                .font(.body)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .textContentType(.URL)
                .submitLabel(.done)
                .onSubmit { model.commitServer() }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 48)
    }

    private var tokenRow: some View {
        HStack(spacing: 8) {
            Text("Token")
                .frame(width: 76, alignment: .leading)
            SecureField(model.tokenSet ? "saved" : "", text: $model.tokenDraft)
                .textFieldStyle(.roundedBorder)
                .textContentType(.password)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .onSubmit { model.commitServer() }
            Text(model.tokenSet || !model.tokenDraft.isEmpty ? "set" : "none")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(width: 44, alignment: .trailing)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 48)
    }

    private var viewersRow: some View {
        HStack(spacing: 8) {
            Text("Viewers")
                .frame(width: 76, alignment: .leading)
            Spacer(minLength: 8)
            Menu {
                ForEach(SettingsStore.people) { person in
                    Button {
                        model.toggleViewer(person.id)
                    } label: {
                        if model.viewerOn(person.id) {
                            Label(person.name, systemImage: "checkmark")
                        } else {
                            Text(person.name)
                        }
                    }
                }
            } label: {
                Text(model.viewerLabel)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .accessibilityLabel("Viewers")
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 48)
    }

    private var ratingRow: some View {
        HStack(spacing: 8) {
            Text("Rating")
                .frame(width: 76, alignment: .leading)
            Picker("Rating", selection: Binding(
                get: { model.rating },
                set: { model.setRating($0) }
            )) {
                Text("G").tag("G")
                Text("PG").tag("PG")
                Text("M").tag("M")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 48)
    }
}
