import Foundation

struct Person: Identifiable, Equatable {
    var id: String
    var name: String
}

/// Server base, viewers and rating live in UserDefaults. The token does not.
final class SettingsStore {
    static let defaultBase = "http://m2:8686"
    static let defaultViewers = "jake,mum,dad"
    static let defaultRating = "PG"
    static let people: [Person] = [
        Person(id: "sam", name: "Sam"),
        Person(id: "jake", name: "Jake"),
        Person(id: "mum", name: "Fran"),
        Person(id: "dad", name: "Ian"),
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

    /// Empty is a real choice (nobody in the room). Missing means the default audience.
    var viewers: String {
        get {
            if defaults.object(forKey: "onto.viewers") == nil { return Self.defaultViewers }
            return defaults.string(forKey: "onto.viewers") ?? ""
        }
        set { defaults.set(newValue, forKey: "onto.viewers") }
    }

    var rating: String {
        get {
            let value = defaults.string(forKey: "onto.rating") ?? ""
            return ["G", "PG", "M"].contains(value) ? value : Self.defaultRating
        }
        set { defaults.set(newValue, forKey: "onto.rating") }
    }

    static func selected(from viewers: String) -> Set<String> {
        Set(viewers.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.filter { !$0.isEmpty })
    }

    /// Ids in household order, so the default set is the string Fred sends.
    static func viewersString(_ on: Set<String>) -> String {
        people.map(\.id).filter { on.contains($0) }.joined(separator: ",")
    }

    static func viewerNames(_ viewers: String) -> String {
        let on = selected(from: viewers)
        let names = people.filter { on.contains($0.id) }.map(\.name)
        return names.isEmpty ? "none" : names.joined(separator: ", ")
    }
}
