import AuthenticationServices
import CryptoKit
import Foundation

/// Sign in with Apple 登录
/// 流程：identityToken（JWT）+ nonce → POST /auth → 返回会话凭证（iOS 存 Keychain）
final class AuthService: NSObject {
    /// 当前 nonce（原始值，用于发给后端校验）
    private(set) var currentNonce: String?
    private var continuation: CheckedContinuation<String, Error>?

    func signInWithApple() async throws -> String {
        let nonce = randomNonce()
        currentNonce = nonce
        let hashedNonce = sha256(nonce)

        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = hashedNonce

        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        controller.performRequests()

        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
        }
    }

    /// 检查 Apple 凭证状态（静默刷新前判断用户是否仍授权本 App）
    func checkCredentialState(userID: String, completion: @escaping (ASAuthorizationAppleIDProvider.CredentialState) -> Void) {
        ASAuthorizationAppleIDProvider().getCredentialState(forUserID: userID, completion: completion)
    }

    private func randomNonce(length: Int = 32) -> String {
        var bytes = [UInt8](repeating: 0, count: length)
        let status = SecRandomCopyBytes(kSecRandomDefault, length, &bytes)
        guard status == errSecSuccess else { return UUID().uuidString }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    private func sha256(_ input: String) -> String {
        let hashed = SHA256.hash(data: Data(input.utf8))
        return hashed.compactMap { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - ASAuthorizationControllerDelegate

extension AuthService: ASAuthorizationControllerDelegate {
    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let token = String(data: tokenData, encoding: .utf8) else {
            continuation?.resume(throwing: AuthError.missingIdentityToken)
            continuation = nil
            return
        }
        continuation?.resume(returning: token)
        continuation = nil
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        if let authError = error as? ASAuthorizationError, authError.code == .canceled {
            continuation?.resume(throwing: AuthError.canceled)
        } else {
            continuation?.resume(throwing: error)
        }
        continuation = nil
    }
}

// MARK: - ASAuthorizationControllerPresentationContextProviding

extension AuthService: ASAuthorizationControllerPresentationContextProviding {
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}

enum AuthError: LocalizedError {
    case missingIdentityToken
    case canceled

    var errorDescription: String? {
        switch self {
        case .missingIdentityToken: return L10n.string("error_generic")
        case .canceled: return L10n.string("login_canceled")
        }
    }
}
