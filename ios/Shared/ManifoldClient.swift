import Foundation

struct ManifoldLensAnchor: Codable, Equatable, Sendable {
    var workId: String
    var weight: Double
    var mark: String?
}

struct ManifoldTVLens: Identifiable, Codable, Equatable, Sendable {
    var id: String
    var domain: String
    var name: String
    var summary: String
    var issuer: String
    var issuerHandle: String
    var modelId: String
    var subscribers: Int?
    var completionRate: Double?
    var anchors: [ManifoldLensAnchor]
    var signatureValid: Bool?
}

struct ManifoldLensesReply: Decodable {
    var count: Int
    var lenses: [ManifoldTVLens]
}

enum ManifoldClient {
    static let defaultHub = "https://manifold-chi.vercel.app"

    static let bundledTVLenses: [ManifoldTVLens] = [
        ManifoldTVLens(
            id: "lens:tv:open-cinema",
            domain: "tv",
            name: "Open studio",
            summary: "Blender Open Movies and kinetic silent physical comedy",
            issuer: "ed25519:archive-curator",
            issuerHandle: "archive.curator",
            modelId: "embeddinggemma-2",
            subscribers: 212,
            completionRate: 0.93,
            anchors: [
                ManifoldLensAnchor(workId: "wikidata:Q752509", weight: 1.0, mark: "good"),
                ManifoldLensAnchor(workId: "wikidata:Q321607", weight: 0.88, mark: "good")
            ],
            signatureValid: true
        ),
        ManifoldTVLens(
            id: "lens:tv:night-flight",
            domain: "tv",
            name: "Night flight",
            summary: "Slow cerebral sci-fi, Zone parables, and nocturnal expressionism",
            issuer: "ed25519:canon-steward",
            issuerHandle: "canon.steward",
            modelId: "embeddinggemma-2",
            subscribers: 148,
            completionRate: 0.89,
            anchors: [
                ManifoldLensAnchor(workId: "wikidata:Q207626", weight: 1.0, mark: "good"),
                ManifoldLensAnchor(workId: "wikidata:Q1202626", weight: 0.80, mark: "good")
            ],
            signatureValid: true
        ),
        ManifoldTVLens(
            id: "lens:tv:midnight-noir",
            domain: "tv",
            name: "Rain & clockwork",
            summary: "Post-war noir, screwball repartee, and Continental mystery",
            issuer: "ed25519:archive-curator",
            issuerHandle: "archive.curator",
            modelId: "embeddinggemma-2",
            subscribers: 94,
            completionRate: 0.87,
            anchors: [
                ManifoldLensAnchor(workId: "wikidata:Q221105", weight: 1.0, mark: "good"),
                ManifoldLensAnchor(workId: "wikidata:Q621917", weight: 0.82, mark: "good")
            ],
            signatureValid: true
        )
    ]

    static func fetchTVLenses(
        hubBase: String = defaultHub,
        session: URLSession = .shared
    ) async throws -> [ManifoldTVLens] {
        let clean = hubBase.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        guard let url = URL(string: "\(clean)/api/v1/lenses?domain=tv") else {
            throw URLError(.badURL)
        }
        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(ManifoldLensesReply.self, from: data).lenses
    }
}
