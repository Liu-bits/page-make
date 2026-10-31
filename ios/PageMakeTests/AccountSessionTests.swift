import XCTest
@testable import PageMake

/// 账号权益模型：游客身份与 VIP 权益是两个维度。
final class AccountSessionTests: XCTestCase {
    private func session(userId: String, role: AccountRole, kind: AccountKind) -> UserSession {
        UserSession(
            token: "token",
            userId: userId,
            email: nil,
            role: role,
            accountKind: kind,
            expiresAt: Date().addingTimeInterval(3600)
        )
    }

    func testGuestPrefixAloneDoesNotDetermineLimits() {
        let ordinaryGuest = session(userId: "guest_123", role: .user, kind: .guest)
        let guestVIP = session(userId: "guest_123", role: .vip, kind: .guestVip)

        XCTAssertTrue(ordinaryGuest.isGuestLimited)
        XCTAssertFalse(guestVIP.isGuestLimited)
        XCTAssertTrue(guestVIP.isVIP)
        XCTAssertEqual(guestVIP.userId, ordinaryGuest.userId, "升级不得更换身份")
    }

    func testSignedInVIPAndOrdinaryAccountAreNotGuestLimited() {
        XCTAssertFalse(session(userId: "google_123", role: .user, kind: .user).isGuestLimited)
        XCTAssertFalse(session(userId: "google_123", role: .vip, kind: .vip).isGuestLimited)
    }

    func testAccountKindDerivesForLegacyTokenWithoutKind() {
        XCTAssertEqual(AccountKind.derive(userId: "guest_123", role: .user), .guest)
        XCTAssertEqual(AccountKind.derive(userId: "guest_123", role: .vip), .guestVip)
        XCTAssertEqual(AccountKind.derive(userId: "guest_123", role: .svip), .guestSvip)
        XCTAssertEqual(AccountKind.derive(userId: "guest_123", role: .ultra), .guestUltra)
        XCTAssertEqual(AccountKind.derive(userId: "google_123", role: .user), .user)
        XCTAssertEqual(AccountKind.derive(userId: "google_123", role: .vip), .vip)
        XCTAssertEqual(AccountKind.derive(userId: "google_123", role: .svip), .svip)
        XCTAssertEqual(AccountKind.derive(userId: "google_123", role: .ultra), .ultra)
    }

    func testTierLimitsAndBackendPermission() {
        XCTAssertEqual(AccountRole.user.defaultStaticMaxBytes, 5 * 1024 * 1024)
        XCTAssertEqual(AccountRole.vip.defaultStaticMaxBytes, 1 * 1024 * 1024)
        XCTAssertEqual(AccountRole.svip.defaultStaticMaxBytes, 100 * 1024 * 1024)
        XCTAssertNil(AccountRole.ultra.defaultStaticMaxBytes)
        XCTAssertFalse(AccountRole.user.canUseBackend)
        XCTAssertTrue(AccountRole.vip.canUseBackend)
        XCTAssertTrue(AccountRole.svip.canUseBackend)
        XCTAssertTrue(AccountRole.ultra.canUseBackend)
    }

    func testAuthResponseDefaultsToUserRoleForOlderServer() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let json = """
        {
          "token": "token",
          "userId": "guest_123",
          "expiresAt": "2099-01-01T00:00:00.000Z"
        }
        """.data(using: .utf8)!

        let response = try decoder.decode(AuthResponse.self, from: json)
        XCTAssertEqual(response.role, .user)
        XCTAssertEqual(response.accountKind, .guest)
    }

    func testAuthResponseDecodesGuestVIP() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let json = """
        {
          "token": "token",
          "userId": "guest_123",
          "role": "vip",
          "accountKind": "guest-vip",
          "expiresAt": "2099-01-01T00:00:00.000Z"
        }
        """.data(using: .utf8)!

        let response = try decoder.decode(AuthResponse.self, from: json)
        XCTAssertEqual(response.role, .vip)
        XCTAssertEqual(response.accountKind, .guestVip)
    }

    func testAuthResponseDecodesQuota() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let json = """
        {
          "token": "token",
          "userId": "google_123",
          "role": "svip",
          "accountKind": "svip",
          "expiresAt": "2099-01-01T00:00:00.000Z",
          "quota": {
            "tier": "svip",
            "canUseBackend": true,
            "canExport": true,
            "staticMaxBytes": 104857600,
            "backendMaxBytes": 104857600
          }
        }
        """.data(using: .utf8)!

        let response = try decoder.decode(AuthResponse.self, from: json)
        XCTAssertEqual(response.role, .svip)
        XCTAssertEqual(response.quota?.staticMaxBytes, 100 * 1024 * 1024)
        XCTAssertEqual(response.quota?.canUseBackend, true)
    }
}
