import SwiftUI

/// 项目列表页
struct ProjectListView: View {
    @EnvironmentObject private var appState: AppState
    let onCreateTapped: () -> Void
    @State private var showVIPLogin = false
    @State private var alertItem: AlertItem?
    @State private var searchText = ""
    @State private var sortOrder: SortOrder = .newest
    @State private var renameTarget: Project?

    enum SortOrder: String, CaseIterable {
        case newest, oldest, name, size

        var titleKey: String {
            switch self {
            case .newest: return "sort_newest"
            case .oldest: return "sort_oldest"
            case .name: return "sort_name"
            case .size: return "sort_size"
            }
        }

        var icon: String {
            switch self {
            case .newest: return "clock.arrow.circlepath"
            case .oldest: return "clock"
            case .name: return "textformat"
            case .size: return "externaldrive"
            }
        }
    }

    /// 过滤 + 排序后的列表
    private var visibleProjects: [Project] {
        let filtered = searchText.trimmingCharacters(in: .whitespaces).isEmpty
            ? appState.projects
            : appState.projects.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
        switch sortOrder {
        case .newest: return filtered.sorted { $0.createdAt > $1.createdAt }
        case .oldest: return filtered.sorted { $0.createdAt < $1.createdAt }
        case .name: return filtered.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        case .size: return filtered.sorted { $0.size > $1.size }
        }
    }

    var body: some View {
        ZStack {
            PageMakeBackground()
            content
        }
        .overlay(alignment: .top) {
            if let message = appState.projectsLoadError {
                ErrorBanner(
                    message: message,
                    actionTitle: L10n.string("retry")
                ) {
                    Task { await appState.retryLoadProjects() }
                } onDismiss: {
                    appState.projectsLoadError = nil
                }
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .onAppear {
            if appState.isLoggedIn {
                Task { await appState.loadProjects(isInitialRestore: true) }
            }
        }
        .sheet(isPresented: $showVIPLogin, onDismiss: {
            if appState.isLoggedIn {
                Task { await appState.loadProjects() }
            }
        }) {
            VIPLoginView()
                .environmentObject(appState)
        }
        .alert(item: $alertItem) { item in
            Alert(
                title: Text(L10n.string(item.titleKey)),
                message: Text(item.message),
                dismissButton: .default(Text(L10n.string("done")))
            )
        }
        .sheet(item: $renameTarget) { target in
            RenameProjectSheet(project: target) { name in
                Task {
                    if let error = await appState.renameProject(target.id, name: name) {
                        alertItem = AlertItem(message: error)
                    }
                }
            }
        }
    }

    private func signInWithGoogle() async {
        if let error = await appState.signInWithGoogle() {
            alertItem = AlertItem(message: error)
        }
    }

    @ViewBuilder
    private var content: some View {
        if !appState.isLoggedIn {
            loggedOutView
        } else if appState.projects.isEmpty {
            emptyView
        } else {
            projectWorkspace
        }
    }

    // MARK: - 未登录

    private var loggedOutView: some View {
        ScrollView {
            VStack(spacing: 22) {
                workspaceHero(isLoggedIn: false)

                PageMakeCard {
                    VStack(alignment: .leading, spacing: 16) {
                        Text(L10n.string("login_choose_title"))
                            .font(.system(.title3, design: .serif, weight: .bold))
                            .foregroundStyle(PageMakeTheme.ink)
                        Text(L10n.string("login_choose_hint"))
                            .font(.subheadline)
                            .foregroundStyle(PageMakeTheme.inkSoft)

                        VStack(spacing: 11) {
                            Button {
                                Task { await appState.signIn() }
                            } label: {
                                Label(L10n.string("login_apple"), systemImage: "apple.logo")
                            }
                            .buttonStyle(PrimaryButtonStyle())

                            Button {
                                Task { await signInWithGoogle() }
                            } label: {
                                Label(L10n.string("login_google"), systemImage: "g.circle.fill")
                            }
                            .buttonStyle(SecondaryButtonStyle())

                            Button {
                                showVIPLogin = true
                            } label: {
                                Label(L10n.string("vip_login"), systemImage: "crown.fill")
                            }
                            .buttonStyle(SecondaryButtonStyle())

                            Button {
                                Task { await appState.signInAsGuest() }
                            } label: {
                                Label(L10n.string("login_guest"), systemImage: "person.fill")
                            }
                            .buttonStyle(SecondaryButtonStyle())
                        }
                    }
                }

                Label(L10n.string("public_links_note"), systemImage: "link")
                    .font(.footnote)
                    .foregroundStyle(PageMakeTheme.inkSoft)
                    .padding(.bottom, 20)
                WorkspaceBottomSpacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
        }
        .refreshable { await appState.loadProjects() }
    }

    // MARK: - 已登录 · 空状态

    private var emptyView: some View {
        ScrollView {
            VStack(spacing: 22) {
                workspaceHero(isLoggedIn: true)

                PageMakeCard(padding: 24) {
                    VStack(spacing: 18) {
                        ZStack {
                            Circle()
                                .fill(PageMakeTheme.coral.opacity(0.11))
                                .frame(width: 92, height: 92)
                            Image(systemName: "rectangle.and.pencil.and.ellipsis")
                                .font(.system(size: 38, weight: .medium))
                                .foregroundStyle(PageMakeTheme.coral)
                        }

                        Text(L10n.string("quick_start_title"))
                            .font(.system(.title2, design: .serif, weight: .bold))
                            .foregroundStyle(PageMakeTheme.ink)
                        Text(L10n.string("quick_start_hint"))
                            .font(.subheadline)
                            .foregroundStyle(PageMakeTheme.inkSoft)
                            .multilineTextAlignment(.center)

                        Button(action: onCreateTapped) {
                            Label(L10n.string("add_project"), systemImage: "plus")
                        }
                        .buttonStyle(PrimaryButtonStyle())

                        creationModes
                    }
                    .frame(maxWidth: .infinity)
                }
                WorkspaceBottomSpacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
        }
        .refreshable { await appState.retryLoadProjects() }
    }

    // MARK: - 已登录 · 列表

    private var projectWorkspace: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                workspaceHero(isLoggedIn: true)

                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(L10n.string("library_title"))
                            .font(.system(.title2, design: .serif, weight: .bold))
                            .foregroundStyle(PageMakeTheme.ink)
                        Text(L10n.format("library_count", visibleProjects.count))
                            .font(.caption)
                            .foregroundStyle(PageMakeTheme.inkSoft)
                    }
                    Spacer()
                    Menu {
                        Picker(L10n.string("sort_by"), selection: $sortOrder) {
                            ForEach(SortOrder.allCases, id: \.self) { order in
                                Label(L10n.string(order.titleKey), systemImage: order.icon)
                                    .tag(order)
                            }
                        }
                    } label: {
                        Label(L10n.string(sortOrder.titleKey), systemImage: "arrow.up.arrow.down")
                            .font(.caption.bold())
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(PageMakeTheme.surface, in: Capsule())
                            .foregroundStyle(PageMakeTheme.ink)
                            .overlay {
                                Capsule().stroke(PageMakeTheme.ink.opacity(0.08), lineWidth: 1)
                            }
                    }
                    .accessibilityLabel(L10n.string("sort_by"))
                }

                searchField

                if visibleProjects.isEmpty {
                    PageMakeCard {
                        HStack(spacing: 13) {
                            Image(systemName: "magnifyingglass")
                                .foregroundStyle(PageMakeTheme.coral)
                            Text(L10n.string("search_empty"))
                                .font(.subheadline)
                                .foregroundStyle(PageMakeTheme.inkSoft)
                        }
                    }
                } else {
                    ForEach(visibleProjects) { project in
                        NavigationLink {
                            destination(for: project)
                        } label: {
                            projectCard(project)
                        }
                        .buttonStyle(.plain)
                        .overlay(alignment: .topTrailing) {
                            if project.status != .uploading && project.status != .processing {
                                projectMenu(project)
                                    .padding(.top, 17)
                                    .padding(.trailing, 14)
                            }
                        }
                        .contextMenu {
                            if project.status != .uploading && project.status != .processing {
                                Button {
                                    renameTarget = project
                                } label: {
                                    Label(L10n.string("rename"), systemImage: "pencil")
                                }
                                Button(role: .destructive) {
                                    Task { await appState.deleteProject(project.id) }
                                } label: {
                                    Label(L10n.string("delete_project"), systemImage: "trash")
                                }
                            }
                        }
                    }
                }
                WorkspaceBottomSpacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 20)
            .animation(.easeOut(duration: 0.24), value: visibleProjects.map(\.id))
        }
        .refreshable { await appState.retryLoadProjects() }
    }

    private func destination(for project: Project) -> some View {
        Group {
            if project.status == .failed {
                ProjectErrorView(project: project)
            } else if project.sourceType == "explorer" {
                ExplorerView(project: project)
            } else {
                PreviewView(project: project)
            }
        }
    }

    // MARK: - 工作台头图

    private func workspaceHero(isLoggedIn: Bool) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Label(L10n.string("studio_badge"), systemImage: "sparkles")
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .textCase(.uppercase)
                    .tracking(0.7)
                    .foregroundStyle(.white.opacity(0.84))
                    .padding(.horizontal, 11)
                    .padding(.vertical, 7)
                    .background(.white.opacity(0.1), in: Capsule())
                    .overlay {
                        Capsule().stroke(.white.opacity(0.14), lineWidth: 1)
                    }
                Spacer()
                Image(systemName: "chevron.left.forwardslash.chevron.right")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.46))
            }

            VStack(alignment: .leading, spacing: 10) {
                Text(L10n.string("studio_headline"))
                    .font(.system(size: 34, weight: .bold, design: .serif))
                    .tracking(-0.7)
                    .foregroundStyle(.white)
                    .fixedSize(horizontal: false, vertical: true)
                Text(L10n.string("studio_subtitle"))
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.72))
                    .fixedSize(horizontal: false, vertical: true)
            }

            if isLoggedIn {
                HStack(spacing: 0) {
                    heroMetric(value: "\(appState.projects.count)", label: L10n.string("dashboard_projects"))
                    heroDivider
                    heroMetric(value: "\(appState.projects.reduce(0) { $0 + $1.fileCount })", label: L10n.string("dashboard_files"))
                    heroDivider
                    heroMetric(value: formatBytes(appState.projects.reduce(Int64(0)) { $0 + $1.size }), label: L10n.string("dashboard_space"))
                }
                .padding(.vertical, 13)
                .background(.black.opacity(0.13), in: RoundedRectangle(cornerRadius: 16, style: .continuous))

                HStack(spacing: 11) {
                    Button(action: onCreateTapped) {
                        Label(L10n.string("add_project"), systemImage: "plus")
                            .font(.system(.subheadline, design: .rounded, weight: .bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(PageMakeTheme.coral, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                            .foregroundStyle(.white)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(22)
        .background(PageMakeTheme.heroGradient, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(alignment: .topTrailing) {
            Circle()
                .stroke(.white.opacity(0.07), lineWidth: 34)
                .frame(width: 190, height: 190)
                .offset(x: 72, y: -82)
                .allowsHitTesting(false)
        }
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .shadow(color: PageMakeTheme.ink.opacity(0.18), radius: 24, x: 0, y: 14)
    }

    private func heroMetric(value: String, label: String) -> some View {
        VStack(spacing: 3) {
            Text(value)
                .font(.system(.headline, design: .rounded, weight: .bold))
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.55))
        }
        .frame(maxWidth: .infinity)
    }

    private var heroDivider: some View {
        Rectangle()
            .fill(.white.opacity(0.12))
            .frame(width: 1, height: 28)
    }

    // MARK: - 搜索与项目卡片

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(PageMakeTheme.inkSoft)
            TextField(L10n.string("search_projects"), text: $searchText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(PageMakeTheme.inkSoft.opacity(0.7))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L10n.string("clear_search"))
            }
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 12)
        .background(PageMakeTheme.surface, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .stroke(PageMakeTheme.ink.opacity(0.07), lineWidth: 1)
        }
    }

    private func projectCard(_ project: Project) -> some View {
        VStack(alignment: .leading, spacing: 15) {
            HStack(alignment: .top, spacing: 13) {
                ZStack {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(projectTint(project).opacity(0.13))
                    Image(systemName: projectIcon(project))
                        .font(.system(size: 21, weight: .semibold))
                        .foregroundStyle(projectTint(project))
                }
                .frame(width: 48, height: 48)

                VStack(alignment: .leading, spacing: 4) {
                    Text(project.name)
                        .font(.system(.headline, design: .rounded, weight: .bold))
                        .foregroundStyle(PageMakeTheme.ink)
                        .lineLimit(1)
                    Text(L10n.string(projectKindKey(project)))
                        .font(.caption)
                        .foregroundStyle(PageMakeTheme.inkSoft)
                }

                Spacer(minLength: 30)
                StatusBadge(status: project.status)
                Color.clear
                    .frame(width: 26, height: 26)
            }

            HStack(spacing: 7) {
                metadataPill(icon: "doc.on.doc", text: L10n.format("file_count", project.fileCount))
                metadataPill(icon: "externaldrive", text: formatBytes(project.size))
            }

            Divider()
                .overlay(PageMakeTheme.ink.opacity(0.06))

            HStack(spacing: 8) {
                Image(systemName: project.publicURL == nil ? "clock" : "link")
                    .font(.caption)
                    .foregroundStyle(project.publicURL == nil ? PageMakeTheme.gold : PageMakeTheme.sea)
                Text(project.publicURL?.host ?? L10n.string("project_link_pending"))
                    .font(.caption)
                    .foregroundStyle(PageMakeTheme.inkSoft)
                    .lineLimit(1)
                Spacer()
                Text(DateParsing.display(project.createdAt))
                    .font(.caption2)
                    .foregroundStyle(PageMakeTheme.inkSoft.opacity(0.8))
                Image(systemName: "chevron.right")
                    .font(.caption2.bold())
                    .foregroundStyle(PageMakeTheme.inkSoft.opacity(0.45))
            }

            if let errorCode = project.errorCode, project.status == .failed {
                Label(PlainLanguage.message(forErrorCode: errorCode), systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(PageMakeTheme.coral)
                    .lineLimit(2)
            }
        }
        .padding(17)
        .background(PageMakeTheme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(PageMakeTheme.ink.opacity(0.065), lineWidth: 1)
        }
        .shadow(color: PageMakeTheme.ink.opacity(0.065), radius: 16, x: 0, y: 8)
        .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func metadataPill(icon: String, text: String) -> some View {
        Label(text, systemImage: icon)
            .font(.caption2)
            .foregroundStyle(PageMakeTheme.inkSoft)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(PageMakeTheme.ink.opacity(0.045), in: Capsule())
    }

    private func projectMenu(_ project: Project) -> some View {
        Menu {
            Button {
                renameTarget = project
            } label: {
                Label(L10n.string("rename"), systemImage: "pencil")
            }
            Button(role: .destructive) {
                Task { await appState.deleteProject(project.id) }
            } label: {
                Label(L10n.string("delete_project"), systemImage: "trash")
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(PageMakeTheme.inkSoft)
                .frame(width: 28, height: 28)
                .background(PageMakeTheme.ink.opacity(0.055), in: Circle())
        }
        .accessibilityLabel(L10n.string("more_actions"))
    }

    private var creationModes: some View {
        HStack(spacing: 9) {
            creationMode(icon: "shippingbox.fill", titleKey: "pick_mode_files")
            creationMode(icon: "chevron.left.forwardslash.chevron.right", titleKey: "pick_mode_paste")
            creationMode(icon: "folder.fill", titleKey: "mode_explorer")
        }
    }

    private func creationMode(icon: String, titleKey: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(PageMakeTheme.sea)
            Text(L10n.string(titleKey))
                .font(.caption2.bold())
                .foregroundStyle(PageMakeTheme.inkSoft)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(PageMakeTheme.paperWarm, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func projectKindKey(_ project: Project) -> String {
        switch project.sourceType {
        case "explorer": return "project_kind_explorer"
        case "paste": return "project_kind_paste"
        default: return "project_kind_zip"
        }
    }

    private func projectIcon(_ project: Project) -> String {
        switch project.sourceType {
        case "explorer": return "folder.fill"
        case "paste": return "chevron.left.forwardslash.chevron.right"
        default: return "shippingbox.fill"
        }
    }

    private func projectTint(_ project: Project) -> Color {
        switch project.sourceType {
        case "explorer": return PageMakeTheme.sea
        case "paste": return PageMakeTheme.coral
        default: return PageMakeTheme.gold
        }
    }

    private func formatBytes(_ bytes: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB]
        formatter.countStyle = .file
        formatter.allowsNonnumericFormatting = false
        return formatter.string(fromByteCount: bytes)
    }
}

/// 项目重命名 sheet：原实现用 `.alert` 内嵌 TextField，iOS 27 上
/// alert 与列表 sheet/导航同时切换时会丢失输入焦点或直接不弹出。
struct RenameProjectSheet: View {
    let project: Project
    let onRename: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var text: String

    init(project: Project, onRename: @escaping (String) -> Void) {
        self.project = project
        self.onRename = onRename
        _text = State(initialValue: project.name)
    }

    private var normalizedName: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(L10n.string("rename_placeholder"), text: $text)
                        .autocorrectionDisabled()
                }
            }
            .navigationTitle(L10n.string("rename_title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.string("confirm")) {
                        let name = normalizedName
                        dismiss()
                        if !name.isEmpty, name != project.name {
                            onRename(name)
                        }
                    }
                    .disabled(normalizedName.isEmpty || normalizedName == project.name)
                }
            }
        }
    }
}
