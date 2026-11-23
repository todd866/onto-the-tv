import Foundation

/// One member of the household as `/api/home` lists them. `on` is whether the server's reply counted
/// them in the room, which is the server's default audience when the app has not chosen one.
struct Person: Identifiable, Equatable, Codable {
    var id: String
    var name: String
    var on: Bool = false
}

/// Server base, viewers, rating and the last household list live in UserDefaults. The token does not.
final class SettingsStore {
    /// What a build without the private xcconfig points at. Not a real server.
    static let placeholderBase = "https://your-mac.example.ts.net:8443"
    /// From Info.plist `OntoDefaultServer`, set by `ONTO_DEFAULT_SERVER` in ios/Config/Base.xcconfig
    /// (overridden by ~/.config/onto-the-tv/ios-private.xcconfig).
    static var defaultBase: String {
        resolveBase(Bundle.main.object(forInfoDictionaryKey: "OntoDefaultServer") as? String)
    }

    /// An empty, unexpanded (`$(...)`) or non-http value falls back to the placeholder.
    static func resolveBase(_ raw: String?) -> String {
        let value = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !value.isEmpty, !value.contains("$("),
              let url = URL(string: value), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", url.host != nil else { return placeholderBase }
        return value
    }
    static let defaultRating = "PG"
    /// Shown before the first `/api/home` reply. Real names come from the server, never from source.
    static let fallbackPeople: [Person] = [
        Person(id: "kid1", name: "Robin"),
        Person(id: "kid2", name: "Max"),
        Person(id: "adult1", name: "Jordan"),
        Person(id: "adult2", name: "Casey"),
    ]

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var base: String {
        get {
            let value = defaults.string(forKey: "onto.serverBase")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return value.isEmpty ? Self.defaultBase : value
        }
        set { defaults.set(newValue, forKey: "onto.serverBase") }
    }

    /// nil: never chosen, so requests leave `viewers` out and the server uses its default audience.
    /// Empty is a real choice (nobody in the room).
    var viewers: String? {
        get { defaults.object(forKey: "onto.viewers") == nil ? nil : (defaults.string(forKey: "onto.viewers") ?? "") }
        set {
            if let newValue { defaults.set(newValue, forKey: "onto.viewers") } else { defaults.removeObject(forKey: "onto.viewers") }
        }
    }

    var rating: String {
        get {
            let value = defaults.string(forKey: "onto.rating") ?? ""
            return ["G", "PG", "M"].contains(value) ? value : Self.defaultRating
        }
        set { defaults.set(newValue, forKey: "onto.rating") }
    }

    var manifoldLensID: String {
        get { defaults.string(forKey: "onto.manifoldLens") ?? "" }
        set {
            if newValue.isEmpty {
                defaults.removeObject(forKey: "onto.manifoldLens")
            } else {
                defaults.set(newValue, forKey: "onto.manifoldLens")
            }
        }
    }

    /// The household from the last `/api/home` reply, or the generic fallback before the first one.
    var people: [Person] {
        get {
            guard let data = defaults.data(forKey: "onto.people"),
                  let list = try? JSONDecoder().decode([Person].self, from: data), !list.isEmpty else { return Self.fallbackPeople }
            return list
        }
        set {
            if let data = try? JSONEncoder().encode(newValue) { defaults.set(data, forKey: "onto.people") }
        }
    }

    /// Keep the server's list for next launch. An empty list (an older server) leaves the cache alone.
    @discardableResult
    func remember(_ viewers: [HomeViewer]) -> [Person] {
        let list = viewers.filter { !$0.id.isEmpty }.map { Person(id: $0.id.lowercased(), name: $0.name, on: $0.on) }
        if !list.isEmpty { people = list }
        return people
    }

    /// Who is ticked. Unchosen (nil) shows the server's default audience from the last reply.
    static func selected(from viewers: String?, people: [Person]) -> Set<String> {
        guard let viewers else { return Set(people.filter(\.on).map(\.id)) }
        return Set(viewers.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.filter { !$0.isEmpty })
    }

    /// Ids in household order, the way the Samsung app sends them.
    static func viewersString(_ on: Set<String>, people: [Person]) -> String {
        people.map(\.id).filter { on.contains($0) }.joined(separator: ",")
    }

    static func viewerNames(_ viewers: String?, people: [Person]) -> String {
        let on = selected(from: viewers, people: people)
        let names = people.filter { on.contains($0.id) }.map(\.name)
        if names.isEmpty { return viewers == nil ? "default" : "none" }
        return names.joined(separator: ", ")
    }
}
