import Foundation
import Capacitor
import UIKit
import UniformTypeIdentifiers

/// Folders the user granted access to through the document picker, and which
/// currently hold an active security-scoped access session.
final class ZiniaAccessRegistry {
    static let shared = ZiniaAccessRegistry()
    private let lock = NSLock()
    private var active: [String: URL] = [:]

    func activate(id: String, url: URL) {
        lock.lock(); defer { lock.unlock() }
        active[id] = url
    }

    func deactivate(id: String) -> URL? {
        lock.lock(); defer { lock.unlock() }
        return active.removeValue(forKey: id)
    }

    func url(for id: String) -> URL? {
        lock.lock(); defer { lock.unlock() }
        return active[id]
    }

    var activeRoots: [URL] {
        lock.lock(); defer { lock.unlock() }
        return Array(active.values)
    }

    /// Whether Python may use `url` as a working directory or project root.
    func isAllowedDirectory(_ url: URL) -> Bool {
        let roots = [ZiniaPaths.workspaceRoot, ZiniaPaths.temporaryRoot] + activeRoots
        return roots.contains { ZiniaPaths.isURL(url, inside: $0) }
    }
}

private struct FolderBookmark: Codable {
    var id: String
    var name: String
    var bookmark: Data
    var addedAt: Date
    var lastPath: String
}

/// Native file access that the official Filesystem plugin does not cover:
/// Apple's document picker (import, export, folder selection), persisted
/// folder bookmarks, and coordinated, atomic file operations inside
/// user-selected folders (iCloud Drive and other File Provider locations).
@objc(ZiniaFilesPlugin)
public class ZiniaFilesPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "ZiniaFilesPlugin"
    public let jsName = "ZiniaFiles"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getWorkspace", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listFolders", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forgetFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mkdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rename", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "copy", returnType: CAPPluginReturnPromise),
    ]

    private enum PickerPurpose {
        case folder(CAPPluginCall)
        case importFiles(CAPPluginCall, destination: URL)
        case export(CAPPluginCall)
    }

    private var pickerPurpose: PickerPurpose?
    private let bookmarksLock = NSLock()
    private let maxTextBytes = 20 * 1024 * 1024

    // MARK: - Workspace

    @objc func getWorkspace(_ call: CAPPluginCall) {
        do {
            try ZiniaPaths.prepare()
            call.resolve([
                "path": ZiniaPaths.workspaceRoot.path,
                "uri": ZiniaPaths.workspaceRoot.absoluteString,
                "sitePackages": ZiniaPaths.sitePackages.path,
                "temporary": ZiniaPaths.temporaryRoot.path,
            ])
        } catch {
            call.reject("Could not prepare the workspace: \(error.localizedDescription)", "WORKSPACE_ERROR")
        }
    }

    // MARK: - Folder bookmarks

    @objc func pickFolder(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
            picker.allowsMultipleSelection = false
            self.present(picker, purpose: .folder(call))
        }
    }

    @objc func listFolders(_ call: CAPPluginCall) {
        let folders = loadBookmarks().map { entry -> [String: Any] in
            var stale = false
            var available = false
            var path = entry.lastPath
            if let url = try? URL(resolvingBookmarkData: entry.bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) {
                available = true
                path = url.path
            }
            return [
                "id": entry.id, "name": entry.name, "path": path, "available": available, "stale": stale,
                "open": ZiniaAccessRegistry.shared.url(for: entry.id) != nil,
                "addedAt": entry.addedAt.timeIntervalSince1970 * 1000,
            ]
        }
        call.resolve(["folders": folders])
    }

    @objc func openFolder(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), var entry = loadBookmarks().first(where: { $0.id == id }) else {
            call.reject("Unknown folder.", "UNKNOWN_FOLDER")
            return
        }
        if let url = ZiniaAccessRegistry.shared.url(for: id) {
            call.resolve(["id": id, "name": entry.name, "path": url.path, "stale": false])
            return
        }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: entry.bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else {
            call.reject("The folder '\(entry.name)' is no longer available. It may have been moved, deleted, or its "
                        + "storage provider is signed out. Select it again.", "FOLDER_UNAVAILABLE")
            return
        }
        guard url.startAccessingSecurityScopedResource() else {
            call.reject("iOS did not grant access to '\(entry.name)'. Select the folder again.", "ACCESS_DENIED")
            return
        }
        if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
            entry.bookmark = fresh
        }
        entry.lastPath = url.path
        updateBookmark(entry)
        ZiniaAccessRegistry.shared.activate(id: id, url: url)
        call.resolve(["id": id, "name": entry.name, "path": url.path, "stale": stale])
    }

    @objc func closeFolder(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("'id' is required.", "INVALID_ARGUMENT")
            return
        }
        ZiniaAccessRegistry.shared.deactivate(id: id)?.stopAccessingSecurityScopedResource()
        call.resolve()
    }

    @objc func forgetFolder(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("'id' is required.", "INVALID_ARGUMENT")
            return
        }
        ZiniaAccessRegistry.shared.deactivate(id: id)?.stopAccessingSecurityScopedResource()
        saveBookmarks(loadBookmarks().filter { $0.id != id })
        call.resolve()
    }

    // MARK: - Import / export

    @objc func importFiles(_ call: CAPPluginCall) {
        let relative = call.getString("destination") ?? ""
        guard let destination = resolve(root: "workspace", path: relative) else {
            call.reject("Invalid destination folder.", "INVALID_PATH")
            return
        }
        DispatchQueue.main.async {
            let types: [UTType] = [.pythonScript, .plainText, .text, .json, .commaSeparatedText, .data]
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
            picker.allowsMultipleSelection = true
            self.present(picker, purpose: .importFiles(call, destination: destination))
        }
    }

    @objc func exportFile(_ call: CAPPluginCall) {
        guard let root = call.getString("root"), let path = call.getString("path"),
              let url = resolve(root: root, path: path) else {
            call.reject("Invalid file.", "INVALID_PATH")
            return
        }
        guard FileManager.default.fileExists(atPath: url.path) else {
            call.reject("The file does not exist.", "NOT_FOUND")
            return
        }
        DispatchQueue.main.async {
            let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
            self.present(picker, purpose: .export(call))
        }
    }

    private func present(_ picker: UIDocumentPickerViewController, purpose: PickerPurpose) {
        if let previous = pickerPurpose {
            pickerCall(previous)?.reject("Another document picker was opened.", "CANCELLED")
        }
        pickerPurpose = purpose
        picker.delegate = self
        guard let presenter = bridge?.viewController else {
            pickerPurpose = nil
            pickerCall(purpose)?.reject("No view controller is available to present the document picker.", "UNAVAILABLE")
            return
        }
        presenter.present(picker, animated: true)
    }

    private func pickerCall(_ purpose: PickerPurpose) -> CAPPluginCall? {
        switch purpose {
        case .folder(let call), .export(let call), .importFiles(let call, _):
            return call
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard let purpose = pickerPurpose else { return }
        pickerPurpose = nil
        switch purpose {
        case .folder(let call): call.resolve(["cancelled": true])
        case .importFiles(let call, _): call.resolve(["cancelled": true, "imported": []])
        case .export(let call): call.resolve(["cancelled": true, "exported": false])
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let purpose = pickerPurpose else { return }
        pickerPurpose = nil
        switch purpose {
        case .folder(let call):
            guard let url = urls.first else {
                call.resolve(["cancelled": true])
                return
            }
            addFolder(url, call: call)
        case .importFiles(let call, let destination):
            importPicked(urls, into: destination, call: call)
        case .export(let call):
            call.resolve(["cancelled": false, "exported": true, "destination": urls.first?.lastPathComponent ?? ""])
        }
    }

    private func addFolder(_ url: URL, call: CAPPluginCall) {
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
            let entry = FolderBookmark(id: UUID().uuidString, name: url.lastPathComponent, bookmark: data,
                                       addedAt: Date(), lastPath: url.path)
            var all = loadBookmarks().filter { $0.lastPath != url.path }
            all.append(entry)
            saveBookmarks(all)
            call.resolve(["cancelled": false, "id": entry.id, "name": entry.name, "path": url.path])
        } catch {
            call.reject("Could not remember access to this folder: \(error.localizedDescription)", "BOOKMARK_FAILED")
        }
    }

    private func importPicked(_ urls: [URL], into destination: URL, call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            let fm = FileManager.default
            var imported: [[String: Any]] = []
            var failures: [[String: Any]] = []
            do {
                try fm.createDirectory(at: destination, withIntermediateDirectories: true)
            } catch {
                call.reject("Could not create the destination folder: \(error.localizedDescription)", "IO_ERROR")
                return
            }
            for source in urls {
                let accessing = source.startAccessingSecurityScopedResource()
                defer { if accessing { source.stopAccessingSecurityScopedResource() } }
                let target = self.uniqueURL(for: source.lastPathComponent, in: destination)
                do {
                    try fm.copyItem(at: source, to: target)
                    imported.append(["name": target.lastPathComponent,
                                     "path": self.relativePath(of: target, root: ZiniaPaths.workspaceRoot)])
                } catch {
                    failures.append(["name": source.lastPathComponent, "error": error.localizedDescription])
                }
            }
            call.resolve(["cancelled": false, "imported": imported, "failed": failures])
        }
    }

    private func uniqueURL(for name: String, in folder: URL) -> URL {
        let fm = FileManager.default
        var candidate = folder.appendingPathComponent(name)
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var counter = 2
        while fm.fileExists(atPath: candidate.path) {
            let numbered = ext.isEmpty ? "\(base) \(counter)" : "\(base) \(counter).\(ext)"
            candidate = folder.appendingPathComponent(numbered)
            counter += 1
        }
        return candidate
    }

    // MARK: - File operations inside a root

    @objc func list(_ call: CAPPluginCall) {
        withURL(call) { url in
            let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey,
                                          .ubiquitousItemDownloadingStatusKey]
            let items = try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: keys,
                                                                    options: [.skipsHiddenFiles])
            let entries = items.map { item -> [String: Any] in
                let values = try? item.resourceValues(forKeys: Set(keys))
                var entry: [String: Any] = [
                    "name": item.lastPathComponent,
                    "type": (values?.isDirectory ?? false) ? "directory" : "file",
                    "size": values?.fileSize ?? 0,
                    "mtime": (values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000,
                ]
                if let status = values?.ubiquitousItemDownloadingStatus {
                    entry["downloaded"] = status == .current
                }
                return entry
            }
            call.resolve(["entries": entries])
        }
    }

    @objc func stat(_ call: CAPPluginCall) {
        withURL(call) { url in
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            let type = (attributes[.type] as? FileAttributeType) == .typeDirectory ? "directory" : "file"
            call.resolve([
                "type": type,
                "size": (attributes[.size] as? NSNumber)?.intValue ?? 0,
                "mtime": ((attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000,
                "path": url.path,
            ])
        }
    }

    @objc func readText(_ call: CAPPluginCall) {
        withURL(call) { url in
            if let values = try? url.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey]),
               let status = values.ubiquitousItemDownloadingStatus, status != .current {
                try? FileManager.default.startDownloadingUbiquitousItem(at: url)
                call.reject("'\(url.lastPathComponent)' is still downloading from iCloud. Try again in a moment.", "NOT_DOWNLOADED")
                return
            }
            var coordinationError: NSError?
            var result: Result<(String, Double), Error> = .failure(CocoaError(.fileReadUnknown))
            NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) { readURL in
                do {
                    let attributes = try FileManager.default.attributesOfItem(atPath: readURL.path)
                    let size = (attributes[.size] as? NSNumber)?.intValue ?? 0
                    if size > self.maxTextBytes {
                        throw NSError(domain: "ZiniaFiles", code: 1, userInfo: [NSLocalizedDescriptionKey:
                            "The file is larger than \(self.maxTextBytes / 1024 / 1024) MB and is not opened in the editor."])
                    }
                    let data = try Data(contentsOf: readURL)
                    guard let text = String(data: data, encoding: .utf8) else {
                        throw NSError(domain: "ZiniaFiles", code: 2, userInfo: [NSLocalizedDescriptionKey:
                            "The file is not valid UTF-8 text."])
                    }
                    let mtime = ((attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000
                    result = .success((text, mtime))
                } catch {
                    result = .failure(error)
                }
            }
            if let coordinationError = coordinationError {
                throw coordinationError
            }
            let (text, mtime) = try result.get()
            call.resolve(["data": text, "mtime": mtime])
        }
    }

    @objc func writeText(_ call: CAPPluginCall) {
        guard let text = call.getString("data") else {
            call.reject("'data' is required.", "INVALID_ARGUMENT")
            return
        }
        let expected = call.getDouble("expectedMtime")
        let overwrite = call.getBool("overwrite", true)
        withURL(call) { url in
            let fm = FileManager.default
            if fm.fileExists(atPath: url.path) {
                if !overwrite {
                    call.reject("A file with that name already exists.", "EXISTS")
                    return
                }
                if let expected = expected,
                   let current = (try? fm.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date,
                   abs(current.timeIntervalSince1970 * 1000 - expected) > 1 {
                    call.reject("The file was changed by another app since it was opened.", "CONFLICT",
                                nil, ["currentMtime": current.timeIntervalSince1970 * 1000])
                    return
                }
            }
            guard let data = text.data(using: .utf8) else {
                call.reject("Could not encode the text as UTF-8.", "ENCODING")
                return
            }
            var coordinationError: NSError?
            var writeError: Error?
            NSFileCoordinator().coordinate(writingItemAt: url, options: [.forReplacing], error: &coordinationError) { writeURL in
                do {
                    try data.write(to: writeURL, options: [.atomic])
                } catch {
                    writeError = error
                }
            }
            if let error = coordinationError ?? (writeError as NSError?) {
                throw error
            }
            let mtime = (((try? fm.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000
            call.resolve(["mtime": mtime])
        }
    }

    @objc func mkdir(_ call: CAPPluginCall) {
        withURL(call) { url in
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: call.getBool("recursive", true))
            call.resolve()
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        withURL(call) { url in
            if url.standardizedFileURL == self.rootURL(call.getString("root") ?? "")?.standardizedFileURL {
                call.reject("Refusing to delete the root of a folder.", "INVALID_PATH")
                return
            }
            var coordinationError: NSError?
            var removeError: Error?
            NSFileCoordinator().coordinate(writingItemAt: url, options: [.forDeleting], error: &coordinationError) { target in
                do { try FileManager.default.removeItem(at: target) } catch { removeError = error }
            }
            if let error = coordinationError ?? (removeError as NSError?) { throw error }
            call.resolve()
        }
    }

    @objc func rename(_ call: CAPPluginCall) {
        moveOrCopy(call, copy: false)
    }

    @objc func copy(_ call: CAPPluginCall) {
        moveOrCopy(call, copy: true)
    }

    private func moveOrCopy(_ call: CAPPluginCall, copy: Bool) {
        guard let root = call.getString("root"), let from = call.getString("from"), let to = call.getString("to"),
              let source = resolve(root: root, path: from), let target = resolve(root: root, path: to) else {
            call.reject("Invalid path.", "INVALID_PATH")
            return
        }
        let fm = FileManager.default
        if fm.fileExists(atPath: target.path) {
            call.reject("'\(target.lastPathComponent)' already exists.", "EXISTS")
            return
        }
        do {
            if copy {
                try fm.copyItem(at: source, to: target)
            } else {
                try fm.moveItem(at: source, to: target)
            }
            call.resolve()
        } catch {
            call.reject(error.localizedDescription, "IO_ERROR")
        }
    }

    // MARK: - Path resolution

    private func rootURL(_ root: String) -> URL? {
        if root == "workspace" {
            return ZiniaPaths.workspaceRoot
        }
        if root.hasPrefix("ext:") {
            return ZiniaAccessRegistry.shared.url(for: String(root.dropFirst(4)))
        }
        return nil
    }

    /// Resolves a root-relative POSIX path, refusing anything that escapes the root.
    private func resolve(root: String, path: String) -> URL? {
        guard let base = rootURL(root) else { return nil }
        if path.hasPrefix("/") || path.contains("\0") || path.count > 4096 { return nil }
        let components = path.split(separator: "/").map(String.init)
        if components.contains("..") { return nil }
        var url = base
        for component in components where component != "." && !component.isEmpty {
            url.appendPathComponent(component)
        }
        return ZiniaPaths.isURL(url, inside: base) ? url : nil
    }

    private func relativePath(of url: URL, root: URL) -> String {
        let path = url.standardizedFileURL.path
        let rootPath = root.standardizedFileURL.path
        guard path.hasPrefix(rootPath) else { return url.lastPathComponent }
        return String(path.dropFirst(rootPath.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    private func withURL(_ call: CAPPluginCall, _ body: @escaping (URL) throws -> Void) {
        guard let root = call.getString("root") else {
            call.reject("'root' is required.", "INVALID_ARGUMENT")
            return
        }
        guard rootURL(root) != nil else {
            call.reject("The folder is not open. Open it again from the Files panel.", "ROOT_NOT_OPEN")
            return
        }
        guard let url = resolve(root: root, path: call.getString("path") ?? "") else {
            call.reject("Invalid path.", "INVALID_PATH")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try body(url)
            } catch {
                let nsError = error as NSError
                let code: String
                switch (nsError.domain, nsError.code) {
                case (NSCocoaErrorDomain, NSFileNoSuchFileError), (NSCocoaErrorDomain, NSFileReadNoSuchFileError):
                    code = "NOT_FOUND"
                case (NSCocoaErrorDomain, NSFileWriteNoPermissionError), (NSCocoaErrorDomain, NSFileReadNoPermissionError):
                    code = "PERMISSION_DENIED"
                case (NSCocoaErrorDomain, NSFileWriteOutOfSpaceError):
                    code = "NO_SPACE"
                default:
                    code = "IO_ERROR"
                }
                call.reject(nsError.localizedDescription, code)
            }
        }
    }

    // MARK: - Bookmark storage

    private func loadBookmarks() -> [FolderBookmark] {
        bookmarksLock.lock(); defer { bookmarksLock.unlock() }
        guard let data = try? Data(contentsOf: ZiniaPaths.bookmarksFile) else { return [] }
        return (try? JSONDecoder().decode([FolderBookmark].self, from: data)) ?? []
    }

    private func saveBookmarks(_ bookmarks: [FolderBookmark]) {
        bookmarksLock.lock(); defer { bookmarksLock.unlock() }
        try? ZiniaPaths.prepare()
        if let data = try? JSONEncoder().encode(bookmarks) {
            try? data.write(to: ZiniaPaths.bookmarksFile, options: [.atomic])
        }
    }

    private func updateBookmark(_ entry: FolderBookmark) {
        var all = loadBookmarks()
        if let index = all.firstIndex(where: { $0.id == entry.id }) {
            all[index] = entry
            saveBookmarks(all)
        }
    }
}
