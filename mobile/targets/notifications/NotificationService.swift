import CryptoKit
import Foundation
import Security
import UserNotifications

/// A notification arrives from the relay as "Sidebots: New message", with the
/// real one beside it, encrypted with this phone's notification key. This opens
/// it and shows the agent's name over what it said, with the count for the
/// app's icon. When it can't, the notification shows as the relay sent it.
class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var shown: UNMutableNotificationContent?

  /// What the server encrypted: the notice its push module builds.
  private struct Notice: Decodable {
    let title: String
    let body: String
    let badge: Int
    let agentId: String
  }

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    self.contentHandler = contentHandler
    let content = request.content.mutableCopy() as! UNMutableNotificationContent
    shown = content
    if let sealed = request.content.userInfo["sealed"] as? String, let notice = open(sealed) {
      content.title = notice.title
      content.body = notice.body
      content.badge = NSNumber(value: notice.badge)
      // One agent's notifications stack together on the Lock Screen.
      content.threadIdentifier = notice.agentId
      // expo-notifications hands the app whatever is under "body" as the notification's data, and a tap opens that agent's chat.
      content.userInfo["body"] = ["agent_id": notice.agentId]
    }
    contentHandler(content)
  }

  override func serviceExtensionTimeWillExpire() {
    if let contentHandler, let shown { contentHandler(shown) }
  }

  /// The notice, opened with the key the app keeps in the Keychain. The sealed
  /// text is the nonce, the encrypted JSON and the tag, in base64.
  private func open(_ sealed: String) -> Notice? {
    guard
      let key = notificationKey(),
      let bytes = Data(base64Encoded: sealed),
      let box = try? AES.GCM.SealedBox(combined: bytes),
      let json = try? AES.GCM.open(box, using: key)
    else { return nil }
    return try? JSONDecoder().decode(Notice.self, from: json)
  }

  /// The key as the app saves it with expo-secure-store: service "app:no-auth",
  /// the key's name as the account, and the key in base64 as the value.
  private func notificationKey() -> SymmetricKey? {
    let name = Data("notification-key".utf8)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "app:no-auth",
      kSecAttrGeneric as String: name,
      kSecAttrAccount as String: name,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var found: CFTypeRef?
    guard
      SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess,
      let stored = found as? Data,
      let text = String(data: stored, encoding: .utf8),
      let raw = Data(base64Encoded: text)
    else { return nil }
    return SymmetricKey(data: raw)
  }
}
