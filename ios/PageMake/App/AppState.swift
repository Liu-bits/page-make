import Foundation

/// 全局应用状态
@MainActor
final class AppState: ObservableObject {
    @Published var session: UserSession?
    @Published var projects: [Project] = []
    @Published var isLoadingProjects = false
    @Published var authError: String?
    @Published var banInfo: BanInfo?

    private let auth = AuthService()
    private let api = APIClient.shared

    var isLoggedIn: Bool {
        guard let session else { return false }
        return !session.isExpired
    }

    init() {
        restoreSession()
    }

    // MARK: - 会话恢复

    private func restoreSession() {
        guard let token = KeychainStore.shared.sessionToken,
              let expiresAt = KeychainStore.shared.sessionExpiresAt,
              let userId = KeychainStore.shared.userId else { return }

        let restored = UserSession(
            token: token,
            userId: userId,
            email: KeychainStore.shared.userEmail,
            expiresAt: expiresAt
        )
        guard !restored.isExpired else {
            KeychainStore.shared.clearSession()
            return
        }
        session = restored
        api.setToken(token)
        Task { await loadProjects() }
        maybeSilentRefresh()
    }

    /// 到期前 1 天静默刷新（用户无感知）
    private func maybeSilentRefresh() {
        guard let session, session.isExpiringSoon else { return }
        auth.checkCredentialState(userID: session.userId) { [weak self] state, _ in
            guard state == .authorized else { return }
            Task { await self?.silentReauthenticate() }
        }
    }

    private func silentReauthenticate() async {
        do {
            let rawNonce = auth.currentNonce ?? ""
            let identityToken = try await auth.signInWithApple()
            let response = try await api.authenticate(identityToken: identityToken, nonce: rawNonce)
            applySession(response)
        } catch {
            // 静默失败：保持现有会话，直到硬过期
        }
    }

    // MARK: - 登录 / 登出

    func signIn() async {
        do {
            let rawNonce = auth.currentNonce ?? ""
            let identityToken = try await auth.signInWithApple()
            let response = try await api.authenticate(identityToken: identityToken, nonce: rawNonce)
            applySession(response)
            await loadProjects()
        } catch let error as APIError {
            if case .banned(let ban) = error {
                banInfo = ban
            } else {
                authError = error.errorDescription
            }
        } catch let error as AuthError where error == .canceled {
            // 用户取消登录，不提示
        } catch {
            authError = error.localizedDescription
        }
    }

    func signOut() {
        KeychainStore.shared.clearSession()
        api.setToken(nil)
        session = nil
        projects = []
        banInfo = nil
    }

    private func applySession(_ response: AuthResponse) {
        let newSession = UserSession(
            token: response.token,
            userId: response.userId,
            email: response.email,
            expiresAt: response.expiresAt
        )
        session = newSession
        api.setToken(response.token)
        KeychainStore.shared.saveSession(response)
    }

    // MARK: - 项目

    func loadProjects() async {
        guard isLoggedIn else { return }
        isLoadingProjects = true
        defer { isLoadingProjects = false }
        do {
            let list = try await api.listProjects()
            projects = list.sorted { ($0.createdAt) > ($1.createdAt) }
        } catch let error as APIError {
            if case .banned(let ban) = error {
                banInfo = ban
            } else {
                authError = error.errorDescription
            }
        } catch {
            authError = L10n.string("error_network")
        }
    }

    @discardableResult
    func deleteProject(_ id: String) async -> Bool {
        do {
            try await api.deleteProject(id)
            projects.removeAll { $0.id == id }
            return true
        } catch let error as APIError {
            authError = error.errorDescription
        } catch {
            authError = L10n.string("error_generic")
        }
        return false
    }

    func upsertProject(_ project: Project) {
        if let index = projects.firstIndex(where: { $0.id == project.id }) {
            projects[index] = project
        } else {
            projects.insert(project, at: 0)
        }
    }
}

// AuthError 声明处已标记 Equatable（enum 无关联值，Swift 自动合成），无需手写扩展
