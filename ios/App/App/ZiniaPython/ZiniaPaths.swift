import Foundation

/// Locations ZiniaPython uses inside the app sandbox.
///
/// * The workspace is the app's Documents folder. Info.plist enables
///   UIFileSharingEnabled / LSSupportsOpeningDocumentsInPlace, so it appears in
///   the Files app as "On My iPhone > ZiniaPython".
/// * Installed packages live in Application Support (private, not shown in
///   Files, excluded from iCloud backup because they can be re-downloaded).
enum ZiniaPaths {
    static var workspaceRoot: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    static var supportRoot: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ZiniaPython", isDirectory: true)
    }

    static var sitePackages: URL {
        supportRoot.appendingPathComponent("site-packages", isDirectory: true)
    }

    static var bookmarksFile: URL {
        supportRoot.appendingPathComponent("folder-bookmarks.json", isDirectory: false)
    }

    static var cacheRoot: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ZiniaPython", isDirectory: true)
    }

    static var temporaryRoot: URL {
        URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
    }

    /// Packages compiled into the app at build time (optional, read-only).
    static var bundledPackages: URL? {
        Bundle.main.resourceURL?.appendingPathComponent("app_packages", isDirectory: true)
    }

    static func prepare() throws {
        let fm = FileManager.default
        for url in [supportRoot, sitePackages, cacheRoot, workspaceRoot] {
            try fm.createDirectory(at: url, withIntermediateDirectories: true)
        }
        var packages = sitePackages
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? packages.setResourceValues(values)
    }

    /// True when `url` is `root` or lies inside it. Both the literal paths and
    /// the symlink-resolved paths are compared (iOS reports the same container
    /// as /var/... and /private/var/...), and `url` may not exist yet.
    static func isURL(_ url: URL, inside root: URL) -> Bool {
        func contains(_ path: String, _ rootPath: String) -> Bool {
            path == rootPath || path.hasPrefix(rootPath.hasSuffix("/") ? rootPath : rootPath + "/")
        }
        func resolved(_ url: URL) -> String {
            var existing = url.standardizedFileURL
            var tail: [String] = []
            while !FileManager.default.fileExists(atPath: existing.path) && existing.pathComponents.count > 1 {
                tail.insert(existing.lastPathComponent, at: 0)
                existing.deleteLastPathComponent()
            }
            var result = existing.resolvingSymlinksInPath()
            for component in tail {
                result.appendPathComponent(component)
            }
            return result.path
        }
        return contains(url.standardizedFileURL.path, root.standardizedFileURL.path)
            || contains(resolved(url), resolved(root))
    }
}
