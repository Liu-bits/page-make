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
        XCTAssertEqual(AccountKind.derive(userId: "google_123", role: .user), .user)
        XCTAssertEqual(AccountKind.derive(userId: "google_123", role: .vip), .vip)
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
}
