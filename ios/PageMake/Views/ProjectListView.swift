import SwiftUI

/// 项目列表页
struct ProjectListView: View {
    @EnvironmentObject private var appState: AppState
    @Binding var showFilePicker: Bool
    @Binding var showSettings: Bool
    @State private var showPasswordAuth = false
    @State private var alertItem: AlertItem?
    @State private var searchText = ""
    @State private var sortOrder: SortOrder = .newest
    @State private var renameTarget: Project?
    @State private var renameText = ""

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
        content
            .navigationTitle(L10n.string("app_projects"))
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    if appState.isLoggedIn {
                        Menu {
                            Picker(L10n.string("sort_by"), selection: $sortOrder) {
                                ForEach(SortOrder.allCases, id: \.self) { order in
                                    Text(L10n.string(order.titleKey)).tag(order)
                                }
                            }
                        } label: {
                            Image(systemName: "arrow.up.arrow.down")
                        }
                        .accessibilityLabel(L10n.string("sort_by"))

                        Button { showFilePicker = true } label: {
                            Image(systemName: "plus")
                        }
                        .accessibilityLabel(L10n.string("add_project"))
                    }
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button { showSettings = true } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel(L10n.string("settings"))
                }
            }
            .onAppear {
                if appState.isLoggedIn {
                    Task { await appState.loadProjects() }
                }
            }
            .refreshable {
                await appState.loadProjects()
            }
            .searchable(text: $searchText, prompt: L10n.string("search_projects"))
            .sheet(isPresented: $showPasswordAuth) {
                PasswordAuthView()
                    .environmentObject(appState)
            }
            .alert(
                L10n.string("rename_title"),
                isPresented: Binding(
                    get: { renameTarget != nil },
                    set: { if !$0 { renameTarget = nil } }
                )
            ) {
                TextField(L10n.string("rename_placeholder"), text: $renameText)
                Button(L10n.string("cancel"), role: .cancel) { renameTarget = nil }
                Button(L10n.string("confirm")) {
                    guard let target = renameTarget else { return }
                    let name = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
                    renameTarget = nil
                    guard !name.isEmpty, name != target.name else { return }
                    Task {
                        if let error = await appState.renameProject(target.id, name: name) {
                            alertItem = AlertItem(message: error)
                        }
                    }
                }
            }
            .alert(item: $alertItem) { item in
                Alert(
                    title: Text(L10n.string(item.titleKey)),
                    message: Text(item.message),
                    dismissButton: .default(Text(L10n.string("done")))
                )
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
            projectList
        }
    }

    // MARK: - 未登录

    private var loggedOutView: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "globe")
                .font(.system(size: 56))
                .foregroundStyle(.secondary)
            Text(L10n.string("welcome_title"))
                .font(.title2.bold())
            Text(L10n.string("welcome_subtitle"))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            GlassEffectContainer(spacing: 14) {
                VStack(spacing: 14) {
                    Button {
                        Task { await appState.signIn() }
                    } label: {
                        Text(L10n.string("login_apple"))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glassProminent)

                    Button {
                        Task { await signInWithGoogle() }
                    } label: {
                        Text(L10n.string("login_google"))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glass)

                    Button {
                        showPasswordAuth = true
                    } label: {
                        Text(L10n.string("password_login"))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glass)

                    Button {
                        Task { await appState.signInAsGuest() }
                    } label: {
                        Text(L10n.string("login_guest"))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glass)
                }
            }
            .padding(.horizontal, 32)
            Text(L10n.string("public_links_note"))
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer()
            Spacer()
        }
    }

    // MARK: - 已登录 · 空状态

    private var emptyView: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "square.stack.3d.up.slash")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text(L10n.string("empty_projects_title"))
                .font(.title3.bold())
            Text(L10n.string("empty_projects_subtitle"))
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button {
                showFilePicker = true
            } label: {
                Text(L10n.string("add_project"))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(PrimaryButtonStyle())
            .padding(.horizontal, 48)
            Spacer()
            Spacer()
        }
    }

    // MARK: - 已登录 · 列表

    private var projectList: some View {
        List {
            ForEach(visibleProjects) { project in
                NavigationLink {
                    if project.status == .failed {
                        ProjectErrorView(project: project)
                    } else {
                        PreviewView(project: project)
                    }
                } label: {
                    projectRow(project)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    if project.status != .uploading && project.status != .processing {
                        Button(role: .destructive) {
                            Task { await appState.deleteProject(project.id) }
                        } label: {
                            Label(L10n.string("delete_project"), systemImage: "trash")
                        }
                        Button {
                            renameText = project.name
                            renameTarget = project
                        } label: {
                            Label(L10n.string("rename"), systemImage: "pencil")
                        }
                        .tint(.blue)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private func projectRow(_ project: Project) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(project.name)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                StatusBadge(status: project.status)
            }
            HStack(spacing: 6) {
                Text(L10n.string(project.provider.titleKey))
                Text("·")
                Text(L10n.format("file_count", project.fileCount))
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            HStack(spacing: 6) {
                Text(L10n.format("created_at", DateParsing.display(project.createdAt)))
                if let expiresAt = project.expiresAt {
                    Text("·")
                    Text(L10n.format("expires_at", DateParsing.display(expiresAt)))
                }
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            if let errorCode = project.errorCode, project.status == .failed {
                Text(PlainLanguage.message(forErrorCode: errorCode))
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
    }
}
