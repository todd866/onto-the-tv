import Foundation
import Security

enum KeychainToken {
    private static let service = "com.iantodd.ontothetv"
    private static let account = "token"

    static func read() -> String {
#if DEBUG
        // Simulator QA only: `simctl launch ... -onto.qaToken <token>` (never in release builds).
        if let qa = UserDefaults.standard.string(forKey: "onto.qaToken"), !qa.isEmpty { return qa }
#endif
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data, let token = String(data: data, encoding: .utf8) else { return "" }
        return token
    }

    static func write(_ token: String) {
        let key: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(key as CFDictionary)
        guard !token.isEmpty else { return }
        var add = key
        add[kSecValueData as String] = Data(token.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}
