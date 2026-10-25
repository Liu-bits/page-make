import Foundation

/// 全局应用状态
@MainActor
final class AppState: ObservableObject {
    @Published var session: UserSession?
    @Published var projects: [Project] = []
    @Published var stats: UserStats?
    @Published var isLoadingProjects = false
    @Published var authError: String?
    @Published var banInfo: BanInfo?
    /// 启动恢复会话时拉取项目失败：用于列表页非阻塞提示 + 重试，不弹全局弹窗
    @Published var projectsLoadError: String?
    /// 当前游客的 VIP 升级申请状态；nil = 尚未提交或读取失败。
    @Published var vipUpgradeRequest: VIPUpgradeRequest?

    private let auth = AuthService()
    private let googleAuth = GoogleAuthService()
    private let api = APIClient.shared
    /// 首开恢复会话已发起拉取时，列表页 onAppear 不应再并发发同一请求。
    private var isRestoringProjects = false
    private var isRefreshingRole = false

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
            role: KeychainStore.shared.accountRole,
            accountKind: KeychainStore.shared.accountKind(for: userId),
            expiresAt: expiresAt
        )
        guard !restored.isExpired else {
            KeychainStore.shared.clearSession()
            return
        }
        session = restored
        api.setToken(token)
        isRestoringProjects = true
        Task { await loadProjects(isInitialRestore: true) }
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
        // 游客退出 = 结束本次试用：清除设备游客标识，下次「以游客身份继续」获得全新身份
        // （重新计时 10 分钟并重新获得 1 个创建名额；旧游客项目链接仍受原 10 分钟 TTL 约束）
        if let session, session.isGuestLimited {
            KeychainStore.shared.clearGuestIdentity()
        }
        KeychainStore.shared.clearSession()
        api.setToken(nil)
        session = nil
        projects = []
        stats = nil
        projectsLoadError = nil
        isRestoringProjects = false
        isRefreshingRole = false
        banInfo = nil
        vipUpgradeRequest = nil
    }

    /// 删除账号：服务端清除全部项目与用户记录；成功后清空本地会话
    /// 返回错误文案（nil = 成功）
    func deleteAccount() async -> String? {
        do {
            try await api.deleteAccount()
            signOut()
            return nil
        } catch let error as APIError {
            if case .banned(let ban) = error {
                banInfo = ban
                return nil
            }
            return error.errorDescription
        } catch {
            return L10n.string("error_generic")
        }
    }

    /// Google 登录；返回错误文案（nil = 成功 / 用户取消 / 已展示封禁页）
    func signInWithGoogle() async -> String? {
        do {
            let idToken = try await googleAuth.signIn()
            let response = try await api.googleAuthenticate(idToken: idToken)
            applySession(response)
            await loadProjects()
            return nil
        } catch let error as AuthError where error == .canceled {
            return nil
        } catch let error as AuthError {
            // 未配置 Client ID 时给出明确提示
            if case .authorizationFailed(let code) = error, code == -3 {
                return L10n.string("google_not_configured")
            }
            return error.errorDescription
        } catch let error as APIError {
            // 封禁中：展示封禁详情页（原因/等级/解封时间），而非一句错误
            if case .banned(let ban) = error {
                banInfo = ban
                return nil
            }
            return error.errorDescription
        } catch {
            // 透出底层错误（ASWebAuthenticationSession / 网络），便于定位
            let ns = error as NSError
            LogStore.shared.append("google_login", result: "failed", errorCode: "\(ns.domain)/\(ns.code)")
            let detail = ns.localizedDescription
            return detail.isEmpty ? "\(ns.domain) \(ns.code)" : "\(ns.domain) \(ns.code)：\(detail)"
        }
    }

    /// 重命名项目；返回错误文案（nil = 成功）
    func renameProject(_ id: String, name: String) async -> String? {
        do {
            let updated = try await api.renameProject(id, name: name)
            if let index = projects.firstIndex(where: { $0.id == id }) {
                projects[index] = updated
            }
            return nil
        } catch let error as APIError {
            return error.errorDescription
        } catch {
            return L10n.string("error_generic")
        }
    }

    /// 加载用量统计
    func loadStats() async {
        stats = try? await api.stats()
        await refreshAccountRole()
        if session?.isGuestLimited == true {
            await refreshVIPUpgradeRequest()
        }
    }

    // MARK: - 项目模式

    /// 创建空白项目（项目模式）；成功返回项目并同步列表，失败返回 nil（错误写入 authError）
    func createExplorerProject(name: String) async -> Project? {
        do {
            let project = try await api.createExplorerProject(name: name)
            upsertProject(project)
            await loadProjects()
            return project
        } catch let error as APIError {
            if case .banned(let ban) = error {
                banInfo = ban
            } else {
                authError = error.errorDescription
            }
            return nil
        } catch {
            authError = L10n.string("error_generic")
            return nil
        }
    }

    /// 游客登录（免费 Apple ID 无法使用 Sign in with Apple 时的兜底）
    func signInAsGuest() async {
        do {
            let response = try await api.guestAuthenticate(deviceId: KeychainStore.shared.deviceId)
            applySession(response)
            await loadProjects()
        } catch let error as APIError {
            // 封禁中的游客身份：展示封禁详情页，而非一句错误
            if case .banned(let ban) = error {
                banInfo = ban
            } else {
                authError = error.errorDescription
            }
        } catch {
            authError = L10n.string("error_generic")
        }
    }

    private func applySession(_ response: AuthResponse) {
        let newSession = UserSession(
            token: response.token,
            userId: response.userId,
            email: response.email,
            role: response.role,
            accountKind: response.accountKind,
            expiresAt: response.expiresAt
        )
        session = newSession
        api.setToken(response.token)
        stats = nil
        KeychainStore.shared.saveSession(response)
    }

    /// 管理后台可能随时给当前账号升级/取消 VIP。列表与设置页刷新时同步角色，
    /// 不要求用户重新登录，同时保留原 token、userId、项目和游客身份。
    func refreshAccountRole() async {
        guard !isRefreshingRole,
              let existing = session,
              !existing.isExpired else { return }
        isRefreshingRole = true
        defer { isRefreshingRole = false }
        guard let snapshot = try? await api.accountSnapshot() else { return }
        applyAccountSnapshot(snapshot, matching: existing)
        // 角色变化时立即丢弃旧申请状态；仍为游客则后台加载一次最新审核结果。
        if session?.isVIP == true {
            vipUpgradeRequest = nil
        } else {
            await refreshVIPUpgradeRequest()
        }
    }

    /// 读取游客升级申请状态。VIP / 普通登录账号不需要请求；游客才展示申请入口。
    func refreshVIPUpgradeRequest() async {
        guard let current = session, current.isGuestLimited else {
            vipUpgradeRequest = nil
            return
        }
        let expected = current
        guard let request = try? await api.vipUpgradeRequest() else { return }
        guard let latest = session,
              latest.userId == expected.userId,
              latest.token == expected.token,
              latest.isGuestLimited else { return }
        vipUpgradeRequest = request
    }

    /// 提交游客 VIP 升级申请；返回错误文案（nil = 成功）。
    func submitVIPUpgradeRequest(note: String) async -> String? {
        guard let current = session, current.isGuestLimited else {
            return L10n.string("vip_request_guest_only")
        }
        do {
            vipUpgradeRequest = try await api.submitVIPUpgradeRequest(note: note)
            return nil
        } catch let error as APIError {
            if case .banned(let ban) = error {
                banInfo = ban
                return nil
            }
            return error.errorDescription
        } catch {
            return L10n.string("error_network")
        }
    }

    /// 将服务端角色的最新快照合并到当前会话；不新建 token、不触碰项目数据。
    /// `expected` 为发起请求时的会话；用于阻止旧响应覆盖切换后的新账号。
    private func applyAccountSnapshot(_ snapshot: AccountSnapshot, matching expected: UserSession) {
        // 请求期间可能已退出或切换账号，绝不能用旧响应覆盖新会话。
        guard let current = session,
              current.userId == expected.userId,
              current.token == expected.token else { return }
        guard current.role != snapshot.role || current.accountKind != snapshot.accountKind else { return }

        let updated = UserSession(
            token: current.token,
            userId: current.userId,
            email: current.email,
            role: snapshot.role,
            accountKind: snapshot.accountKind,
            expiresAt: current.expiresAt
        )
        session = updated
        KeychainStore.shared.set(snapshot.role.rawValue, for: "account_role")
        KeychainStore.shared.set(snapshot.accountKind.rawValue, for: "account_kind")
    }

    // MARK: - 项目

    func loadProjects(isInitialRestore: Bool = false) async {
        guard isLoggedIn else { return }
        if isInitialRestore, isRestoringProjects, isLoadingProjects {
            // 冷启动时 restoreSession 和 ProjectListView.onAppear 会先后触发；
            // 同一份列表没必要并发请求两次（尤其会放大限速/网关抖动）。
            return
        }
        isRestoringProjects = isInitialRestore
        isLoadingProjects = true
        defer {
            isLoadingProjects = false
            isRestoringProjects = false
        }
        do {
            let result = try await api.listProjects()
            projects = result.projects.sorted { ($0.createdAt) > ($1.createdAt) }
            projectsLoadError = nil
            // /api/projects 已返回同一份权威角色快照，直接应用，避免再请求 /api/stats。
            // 若项目列表与设置页同时刷新，角色更新也不会额外放大网关抖动。
            if let account = result.account, let requestedSession = session {
                applyAccountSnapshot(account, matching: requestedSession)
            } else {
                await refreshAccountRole()
            }
        } catch let error as APIError {
            if case .banned(let ban) = error {
                banInfo = ban
            } else if case .http(let status, _) = error, status == 401 {
                // 服务端会话失效：清理本地凭证并回登录页，避免停在空列表反复报错。
                let message = L10n.string("session_expired")
                signOut()
                // signOut 会清理登录态；横幅挂在 RootView，不会和登录 sheet 抢 presentation。
                authError = message
            } else if isInitialRestore {
                // 首开恢复旧会话时网络失败是常见冷启动抖动：保留页面可用、
                // 在列表内显示“重试”，绝不能用全局 alert 拦截所有按钮。
                projectsLoadError = error.errorDescription
            } else {
                authError = error.errorDescription
            }
        } catch {
            if isInitialRestore {
                projectsLoadError = L10n.string("error_network")
            } else {
                authError = L10n.string("error_network")
            }
        }
    }

    func retryLoadProjects() async {
        projectsLoadError = nil
        isRestoringProjects = false
        await loadProjects(isInitialRestore: true)
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

    /// 创建完成后的统一入口：先本地插入保证立即显示，再从服务端拉取权威列表。
    /// 上传/粘贴都在异步队列里完成，不能依赖列表页 onAppear 的时序。
    func projectDidBecomeReady(_ project: Project) async {
        upsertProject(project)
        await loadProjects()
    }
}

// AuthError 声明处已标记 Equatable（enum 无关联值，Swift 自动合成），无需手写扩展
