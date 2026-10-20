import Foundation
import Capacitor
import UIKit

/// Capacitor plugin exposing the embedded CPython runtime to the web UI.
///
/// Every method validates its arguments, converts the call into a JSON request
/// for `zinia.bridge.handle()` and resolves with the structured result. Output
/// produced while a request runs is streamed through the "output" event before
/// the promise resolves. Only one request runs at a time; a second one is
/// rejected with code "BUSY" rather than silently queued behind a script that
/// may never finish.
@objc(ZiniaPythonPlugin)
public class ZiniaPythonPlugin: CAPPlugin, CAPBridgedPlugin, ZPInterpreterDelegate {
    public let identifier = "ZiniaPythonPlugin"
    public let jsName = "ZiniaPython"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "ping", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "initialize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getRuntimeInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "execute", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "executeFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "interrupt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "provideInput", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "replExecute", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resetInterpreter", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "runSelfTest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkModules", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listPackages", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "analyzePackage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "installPackage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "uninstallPackage", returnType: CAPPluginReturnPromise),
    ]

    static let pluginVersion = "1.0.0"
    private static let maxSourceBytes = 20 * 1024 * 1024
    private static let memoryFloor: UInt64 = 96 * 1024 * 1024

    private let interpreter = ZPInterpreter.shared
    // Assigned in load(), which Capacitor calls before any method or interpreter callback.
    private var batcher: ZiniaOutputBatcher!
    private let lock = NSLock()
    private var busyWith: String?
    private var runtimeInfo: [String: Any]?
    private var memoryTimer: DispatchSourceTimer?
    private var memoryStopped: Set<String> = []
    /// Read once on the main thread in load(); UIDevice is main-thread API.
    private var deviceInfo: [String: Any] = [:]

    override public func load() {
        let device = UIDevice.current
        deviceInfo = ["systemName": device.systemName, "systemVersion": device.systemVersion, "deviceModel": device.model]
        batcher = ZiniaOutputBatcher { [weak self] chunks in
            self?.notifyListeners("output", data: ["chunks": chunks])
        }
        interpreter.delegate = self
        NotificationCenter.default.addObserver(self, selector: #selector(didReceiveMemoryWarning),
                                               name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - Diagnostics

    /// Harmless round trip used to prove the native bridge is wired up.
    @objc func ping(_ call: CAPPluginCall) {
        call.resolve([
            "pong": true,
            "plugin": jsName,
            "pluginVersion": ZiniaPythonPlugin.pluginVersion,
            "compiledPythonVersion": ZPInterpreter.compiledPythonVersion,
            "interpreterState": stateName(interpreter.state),
            "echo": call.getString("message") ?? "",
        ])
    }

    // MARK: - Lifecycle

    @objc func initialize(_ call: CAPPluginCall) {
        startRuntime { result in
            switch result {
            case .success(let info):
                call.resolve(info)
            case .failure(let diagnostic):
                call.reject(diagnostic.message, diagnostic.code, nil, diagnostic.data)
            }
        }
    }

    @objc func getRuntimeInfo(_ call: CAPPluginCall) {
        var info = nativeInfo()
        lock.lock()
        if let runtime = runtimeInfo {
            info.merge(runtime) { _, new in new }
        }
        info["busy"] = busyWith != nil
        lock.unlock()
        call.resolve(info)
    }

    struct Diagnostic: Error {
        let code: String
        let message: String
        let data: [String: Any]
    }

    func startRuntime(completion: @escaping (Result<[String: Any], Diagnostic>) -> Void) {
        do {
            try ZiniaPaths.prepare()
        } catch {
            completion(.failure(Diagnostic(code: "PATHS_FAILED",
                                           message: "Could not create the app's working folders: \(error.localizedDescription)",
                                           data: ["retryable": true])))
            return
        }
        guard var resourcePath = Bundle.main.resourcePath else {
            completion(.failure(Diagnostic(code: "NO_BUNDLE", message: "The app bundle path is unavailable.", data: [:])))
            return
        }
        if UserDefaults.standard.bool(forKey: "ZiniaSimulateMissingStdlib") {
            // Test 15: launch with "-ZiniaSimulateMissingStdlib YES" to exercise the diagnostic path.
            resourcePath += "/__zinia_simulated_missing_runtime__"
        }
        let configuration: [String: Any] = [
            "workspaceRoot": ZiniaPaths.workspaceRoot.path,
            "sitePackages": ZiniaPaths.sitePackages.path,
            "appPackages": ZiniaPaths.bundledPackages?.path ?? "",
            "userRoots": [ZiniaPaths.workspaceRoot.path],
            "outputLimit": 2_000_000,
        ]
        let started = Date()
        interpreter.start(resourcePath: resourcePath, configuration: configuration) { [weak self] json, error in
            guard let self = self else { return }
            if let error = error as NSError? {
                completion(.failure(self.diagnostic(for: error)))
                return
            }
            guard let json = json, let reply = self.parse(json), let result = reply["result"] as? [String: Any] else {
                completion(.failure(Diagnostic(code: "BRIDGE_INIT_FAILED", message: "The runtime returned an unreadable start-up reply.", data: [:])))
                return
            }
            var info = self.nativeInfo()
            info.merge(result) { _, new in new }
            info["startupMs"] = Date().timeIntervalSince(started) * 1000
            self.lock.lock()
            self.runtimeInfo = info
            self.lock.unlock()
            completion(.success(info))
        }
    }

    private func diagnostic(for error: NSError) -> Diagnostic {
        let codes: [Int: String] = [
            ZPErrorCode.frameworkMissing.rawValue: "FRAMEWORK_MISSING",
            ZPErrorCode.stdlibMissing.rawValue: "STDLIB_MISSING",
            ZPErrorCode.supportMissing.rawValue: "SUPPORT_MISSING",
            ZPErrorCode.preInitFailed.rawValue: "PREINIT_FAILED",
            ZPErrorCode.initFailed.rawValue: "INIT_FAILED",
            ZPErrorCode.bridgeImportFailed.rawValue: "BRIDGE_IMPORT_FAILED",
            ZPErrorCode.bridgeInitFailed.rawValue: "BRIDGE_INIT_FAILED",
            ZPErrorCode.alreadyFailed.rawValue: "ALREADY_FAILED",
        ]
        let code = error.domain == ZPErrorDomain ? (codes[error.code] ?? "INIT_FAILED") : "INIT_FAILED"
        var data: [String: Any] = [
            "code": code,
            "retryable": interpreter.state == .notStarted,
            "compiledPythonVersion": ZPInterpreter.compiledPythonVersion,
            "stdlibFolder": ZPInterpreter.stdlibFolderName,
        ]
        if let missing = error.userInfo["missingPaths"] as? [String] {
            data["missingPaths"] = missing
        }
        if let traceback = error.userInfo["pythonTraceback"] as? String, !traceback.isEmpty {
            data["pythonTraceback"] = traceback
        }
        return Diagnostic(code: code, message: error.localizedDescription, data: data)
    }

    private func nativeInfo() -> [String: Any] {
        var info = deviceInfo
        info.merge([
            "compiledPythonVersion": ZPInterpreter.compiledPythonVersion,
            "interpreterState": stateName(interpreter.state),
            "availableMemoryBytes": ZPInterpreter.availableMemory,
            "physicalMemoryBytes": ProcessInfo.processInfo.physicalMemory,
            "pluginVersion": ZiniaPythonPlugin.pluginVersion,
            "interruptSupport": "keyboard-interrupt",
            "workspaceRoot": ZiniaPaths.workspaceRoot.path,
            "sitePackages": ZiniaPaths.sitePackages.path,
        ] as [String: Any]) { _, new in new }
        return info
    }

    private func stateName(_ state: ZPInterpreterState) -> String {
        switch state {
        case .notStarted: return "not-initialized"
        case .starting: return "initializing"
        case .ready: return "ready"
        case .failed: return "failed"
        @unknown default: return "unknown"
        }
    }

    // MARK: - Execution

    @objc func execute(_ call: CAPPluginCall) {
        guard let executionId = requireExecutionId(call),
              let code = requireString(call, "code", maxBytes: ZiniaPythonPlugin.maxSourceBytes) else { return }
        var request: [String: Any] = ["op": "execute", "executionId": executionId, "code": code]
        guard addCommonRunOptions(call, to: &request) else { return }
        if let filename = call.getString("filename") {
            guard filename.utf8.count <= 4096, !filename.contains("\0") else {
                call.reject("'filename' is invalid.", "INVALID_ARGUMENT")
                return
            }
            request["filename"] = filename
        }
        submit(request, call: call, executionId: executionId, interruptible: true)
    }

    @objc func executeFile(_ call: CAPPluginCall) {
        guard let executionId = requireExecutionId(call),
              let path = requireString(call, "path", maxBytes: 4096) else { return }
        let url = URL(fileURLWithPath: path)
        guard path.hasPrefix("/"), ZiniaAccessRegistry.shared.isAllowedDirectory(url.deletingLastPathComponent()) else {
            call.reject("The file is outside the workspace and the folders you opened.", "PATH_NOT_ALLOWED")
            return
        }
        var request: [String: Any] = ["op": "executeFile", "executionId": executionId, "path": path]
        guard addCommonRunOptions(call, to: &request) else { return }
        submit(request, call: call, executionId: executionId, interruptible: true)
    }

    @objc func replExecute(_ call: CAPPluginCall) {
        guard let executionId = requireExecutionId(call),
              let source = requireString(call, "source", maxBytes: ZiniaPythonPlugin.maxSourceBytes) else { return }
        let mode = call.getString("mode") ?? "line"
        guard mode == "line" || mode == "block" else {
            call.reject("'mode' must be 'line' or 'block'.", "INVALID_ARGUMENT")
            return
        }
        var request: [String: Any] = ["op": "repl", "executionId": executionId, "source": source, "mode": mode]
        guard addCommonRunOptions(call, to: &request) else { return }
        submit(request, call: call, executionId: executionId, interruptible: true)
    }

    @objc func resetInterpreter(_ call: CAPPluginCall) {
        submit(["op": "reset"], call: call, executionId: nil, interruptible: false)
    }

    @objc func runSelfTest(_ call: CAPPluginCall) {
        submit(["op": "selftest", "modules": call.getBool("modules", true)], call: call, executionId: nil, interruptible: false)
    }

    @objc func checkModules(_ call: CAPPluginCall) {
        var request: [String: Any] = ["op": "modules"]
        if let names = call.getArray("names", String.self) {
            guard names.count <= 500, names.allSatisfy({ $0.count <= 200 }) else {
                call.reject("Too many module names.", "INVALID_ARGUMENT")
                return
            }
            request["names"] = names
        }
        submit(request, call: call, executionId: nil, interruptible: false)
    }

    @objc func interrupt(_ call: CAPPluginCall) {
        guard let executionId = requireExecutionId(call) else { return }
        if let mechanism = interpreter.interrupt(executionId: executionId) {
            call.resolve(["interrupted": true, "mechanism": mechanism])
        } else {
            call.resolve(["interrupted": false, "mechanism": "none", "reason": "not-running"])
        }
    }

    @objc func provideInput(_ call: CAPPluginCall) {
        guard let executionId = requireExecutionId(call) else { return }
        let eof = call.getBool("eof", false)
        let text = call.getString("text") ?? ""
        guard text.utf8.count <= 1_000_000 else {
            call.reject("Input is too long.", "INVALID_ARGUMENT")
            return
        }
        let accepted = interpreter.provideInput(eof ? nil : text, executionId: executionId)
        call.resolve(["accepted": accepted])
    }

    // MARK: - Packages

    @objc func listPackages(_ call: CAPPluginCall) {
        submit(["op": "packages.list"], call: call, executionId: nil, interruptible: false)
    }

    @objc func analyzePackage(_ call: CAPPluginCall) {
        packageRequest(call, op: "packages.analyze")
    }

    @objc func installPackage(_ call: CAPPluginCall) {
        packageRequest(call, op: "packages.install")
    }

    @objc func uninstallPackage(_ call: CAPPluginCall) {
        packageRequest(call, op: "packages.uninstall")
    }

    private func packageRequest(_ call: CAPPluginCall, op: String) {
        guard let name = requireString(call, "name", maxBytes: 200) else { return }
        var request: [String: Any] = ["op": op, "name": name]
        if let version = call.getString("version"), !version.isEmpty {
            guard version.count <= 100 else {
                call.reject("'version' is too long.", "INVALID_ARGUMENT")
                return
            }
            request["version"] = version
        }
        submit(request, call: call, executionId: nil, interruptible: false)
    }

    // MARK: - Request plumbing

    private func requireExecutionId(_ call: CAPPluginCall) -> String? {
        guard let id = call.getString("executionId"), !id.isEmpty, id.count <= 128,
              id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else {
            call.reject("'executionId' must be 1-128 characters of A-Z, a-z, 0-9, '-' or '_'.", "INVALID_ARGUMENT")
            return nil
        }
        return id
    }

    private func requireString(_ call: CAPPluginCall, _ key: String, maxBytes: Int) -> String? {
        guard let value = call.getString(key) else {
            call.reject("'\(key)' is required.", "INVALID_ARGUMENT")
            return nil
        }
        guard value.utf8.count <= maxBytes else {
            call.reject("'\(key)' is too large.", "INVALID_ARGUMENT")
            return nil
        }
        return value
    }

    private func addCommonRunOptions(_ call: CAPPluginCall, to request: inout [String: Any]) -> Bool {
        for (jsKey, pyKey) in [("workingDirectory", "cwd"), ("projectRoot", "projectRoot")] {
            guard let value = call.getString(jsKey), !value.isEmpty else { continue }
            let url = URL(fileURLWithPath: value, isDirectory: true)
            guard value.hasPrefix("/"), ZiniaAccessRegistry.shared.isAllowedDirectory(url) else {
                call.reject("'\(jsKey)' must be inside the workspace or a folder you opened.", "PATH_NOT_ALLOWED")
                return false
            }
            request[pyKey] = value
        }
        if let stdin = call.getString("stdin") {
            guard stdin.utf8.count <= 10_000_000 else {
                call.reject("'stdin' is too large.", "INVALID_ARGUMENT")
                return false
            }
            request["stdin"] = stdin
        }
        if let args = call.getArray("args", String.self) {
            guard args.count <= 256 else {
                call.reject("Too many arguments.", "INVALID_ARGUMENT")
                return false
            }
            request["args"] = args
        }
        let roots = [ZiniaPaths.workspaceRoot.path] + ZiniaAccessRegistry.shared.activeRoots.map { $0.path }
        request["userRoots"] = roots
        return true
    }

    private func submit(_ request: [String: Any], call: CAPPluginCall, executionId: String?, interruptible: Bool) {
        guard interpreter.state == .ready else {
            call.reject("The Python runtime is not ready. Initialise it first.", "NOT_READY")
            return
        }
        let label = executionId ?? (request["op"] as? String ?? "request")
        lock.lock()
        if let current = busyWith {
            lock.unlock()
            call.reject("Python is busy with '\(current)'. Wait for it to finish or stop it first.", "BUSY")
            return
        }
        busyWith = label
        lock.unlock()

        guard let data = try? JSONSerialization.data(withJSONObject: request),
              let json = String(data: data, encoding: .utf8) else {
            clearBusy()
            call.reject("Could not encode the request.", "INVALID_ARGUMENT")
            return
        }
        if interruptible, let executionId = executionId {
            startMemoryGuard(executionId: executionId)
        }
        let started = DispatchTime.now()
        interpreter.submit(requestJSON: json, executionId: interruptible ? executionId : nil) { [weak self] response in
            guard let self = self else { return }
            let wallMs = Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000
            self.batcher.flush {
                self.stopMemoryGuard()
                self.clearBusy()
                guard let reply = self.parse(response) else {
                    call.reject("The runtime returned an unreadable reply.", "INTERNAL")
                    return
                }
                if reply["ok"] as? Bool == true {
                    var result = reply["result"] as? [String: Any] ?? [:]
                    result["wallTimeMs"] = wallMs
                    if let executionId = executionId, self.consumeMemoryStop(executionId) {
                        result["stoppedBy"] = "memory-guard"
                    }
                    call.resolve(result)
                } else {
                    let error = reply["error"] as? [String: Any] ?? [:]
                    call.reject(error["message"] as? String ?? "Unknown runtime error.",
                                error["code"] as? String ?? "INTERNAL", nil, error)
                }
            }
        }
    }

    private func clearBusy() {
        lock.lock()
        busyWith = nil
        lock.unlock()
    }

    private func parse(_ json: String) -> [String: Any]? {
        guard let data = json.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    // MARK: - Memory guard

    private func startMemoryGuard(executionId: String) {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
        timer.setEventHandler { [weak self] in
            let available = ZPInterpreter.availableMemory
            // os_proc_available_memory() returns 0 where no limit applies (e.g. Simulator).
            if available > 0 && available < ZiniaPythonPlugin.memoryFloor {
                self?.stopForMemory(executionId: executionId, availableBytes: available)
            }
        }
        lock.lock()
        memoryTimer?.cancel()
        memoryTimer = timer
        lock.unlock()
        timer.resume()
    }

    private func stopMemoryGuard() {
        lock.lock()
        memoryTimer?.cancel()
        memoryTimer = nil
        lock.unlock()
    }

    private func stopForMemory(executionId: String, availableBytes: UInt64) {
        lock.lock()
        let first = memoryStopped.insert(executionId).inserted
        lock.unlock()
        guard first, interpreter.interrupt(executionId: executionId) != nil else { return }
        let megabytes = availableBytes / 1024 / 1024
        batcher.append(executionId: executionId, stream: "system",
                       text: "\n[ZiniaPython] Stopping the script: the app is close to the iOS memory limit "
                           + "(\(megabytes) MB left). iOS would otherwise terminate ZiniaPython.\n")
    }

    private func consumeMemoryStop(_ executionId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return memoryStopped.remove(executionId) != nil
    }

    @objc private func didReceiveMemoryWarning() {
        if let executionId = interpreter.activeExecutionId {
            stopForMemory(executionId: executionId, availableBytes: ZPInterpreter.availableMemory)
        }
    }

    // MARK: - ZPInterpreterDelegate (called on the interpreter thread)

    public func interpreterDidEmitOutput(_ text: String, stream: ZPOutputStream, executionId: String) {
        let name: String
        switch stream {
        case .stderr: name = "stderr"
        case .system: name = "system"
        default: name = "stdout"
        }
        batcher.append(executionId: executionId, stream: name, text: text)
    }

    public func interpreterDidEmitEvent(_ name: String, payloadJSON: String) {
        guard name == "packageProgress", let payload = parse(payloadJSON) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.notifyListeners(name, data: payload)
        }
    }

    public func interpreterWillWaitForInput(executionId: String) {
        batcher.flush { [weak self] in
            self?.notifyListeners("inputRequest", data: ["executionId": executionId])
        }
    }
}
