import SwiftUI

/// 项目列表页
struct ProjectListView: View {
    @EnvironmentObject private var appState: AppState
    @Binding var showFilePicker: Bool
    @Binding var showSettings: Bool
    @State private var alertItem: AlertItem?

    var body: some View {
        content
            .navigationTitle(L10n.string("app_projects"))
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    if appState.isLoggedIn {
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
            .alert(item: $alertItem) { item in
                Button(L10n.string("done"), role: .cancel) {}
            } message: {
                Text(item.message)
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
            Button {
                Task { await appState.signIn() }
            } label: {
                Text(L10n.string("login_apple"))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(PrimaryButtonStyle())
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
            ForEach(appState.projects) { project in
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
