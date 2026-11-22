import SwiftUI

struct SettingsScreen: View {
    @Bindable var model: AppleModel
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(spacing: 0) {
            serverRow
            Divider().padding(.leading, 80)
            tokenRow
            Divider().padding(.leading, 80)
            viewersRow
            Divider().padding(.leading, 80)
            ratingRow
            Spacer(minLength: 0)
        }
        .padding(.top, 48)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(TVColor.canvas(scheme))
        .onExitCommand {
            model.commitServer()
            model.showSettings = false
        }
    }

    private var serverRow: some View {
        row("Server") {
            TextField(SettingsStore.placeholderBase, text: $model.serverDraft)
                .font(.title2)
                .autocorrectionDisabled()
                .onSubmit { model.commitServer() }
        }
    }

    private var tokenRow: some View {
        row("Token") {
            HStack(spacing: 24) {
                SecureField(model.tokenSet ? "saved" : "", text: $model.tokenDraft)
                    .font(.title2)
                    .onSubmit { model.commitServer() }
                Text(model.tokenSet || !model.tokenDraft.isEmpty ? "set" : "none")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .frame(width: 88, alignment: .leading)
            }
        }
    }

    private var viewersRow: some View {
        row("Viewers") {
            Menu {
                ForEach(model.people) { person in
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
                    .font(.title2)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityLabel("Viewers")
        }
    }

    private var ratingRow: some View {
        row("Rating") {
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
            .frame(width: 520, alignment: .leading)
        }
    }

    private func row<Control: View>(_ title: String, @ViewBuilder control: () -> Control) -> some View {
        HStack(spacing: 24) {
            Text(title)
                .font(.title2.weight(.semibold))
                .lineLimit(1)
                .frame(width: 320, alignment: .leading)
            control()
                .frame(maxWidth: 900, alignment: .leading)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 80)
        .frame(maxWidth: .infinity, minHeight: 100, alignment: .leading)
    }
}
