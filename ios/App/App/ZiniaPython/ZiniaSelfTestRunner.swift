import Foundation

/// Headless runtime check used by CI on the iOS Simulator.
///
/// Launch the app with the argument `--zinia-selftest`. The runner starts the
/// embedded interpreter exactly as the IDE does, runs zinia.selftest (real
/// imports, real script executions), prints the JSON report between marker
/// lines on stdout, writes it to Documents/zinia-selftest.json, and exits with
/// status 0 (all passed) or 1. The web UI is not involved.
enum ZiniaSelfTestRunner {
    static let argument = "--zinia-selftest"
    static let beginMarker = "=====ZINIA-SELFTEST-BEGIN====="
    static let endMarker = "=====ZINIA-SELFTEST-END====="

    /// Strong reference: the plugin's callbacks hold it weakly.
    private static var plugin: ZiniaPythonPlugin?

    static var isRequested: Bool {
        ProcessInfo.processInfo.arguments.contains(argument)
    }

    static func run() {
        let plugin = ZiniaPythonPlugin()
        plugin.load()
        self.plugin = plugin
        var report: [String: Any] = ["startedAt": Date().timeIntervalSince1970]

        // Test 15: a broken bundle layout must produce a diagnostic, not a crash.
        let bogus = (Bundle.main.resourcePath ?? "") + "/__zinia_missing_runtime__"
        let layoutError = ZPInterpreter.validateBundleLayout(resourcePath: bogus).map { $0 as NSError }
        report["missingRuntimeDiagnostic"] = [
            "detected": layoutError?.code == ZPErrorCode.stdlibMissing.rawValue,
            "message": layoutError?.localizedDescription ?? "",
        ]

        plugin.startRuntime { result in
            switch result {
            case .failure(let diagnostic):
                report["initialized"] = false
                report["initError"] = ["code": diagnostic.code, "message": diagnostic.message, "data": diagnostic.data]
                finish(report, success: false)
            case .success(let info):
                report["initialized"] = true
                report["runtime"] = info
                ZPInterpreter.shared.submit(requestJSON: "{\"op\":\"selftest\",\"modules\":true}", executionId: nil) { response in
                    let parsed = (try? JSONSerialization.jsonObject(with: Data(response.utf8))) as? [String: Any]
                    let result = parsed?["result"] as? [String: Any]
                    report["selftest"] = result ?? parsed ?? ["raw": response]
                    let summary = result?["summary"] as? [String: Any]
                    let ok = (summary?["ok"] as? Bool ?? false)
                        && ((report["missingRuntimeDiagnostic"] as? [String: Any])?["detected"] as? Bool ?? false)
                    finish(report, success: ok)
                }
            }
        }
    }

    private static func finish(_ report: [String: Any], success: Bool) {
        var final = report
        final["success"] = success
        let data = (try? JSONSerialization.data(withJSONObject: final, options: [.prettyPrinted, .sortedKeys])) ?? Data()
        let text = String(data: data, encoding: .utf8) ?? "{}"
        try? data.write(to: ZiniaPaths.workspaceRoot.appendingPathComponent("zinia-selftest.json"), options: .atomic)
        print(beginMarker)
        print(text)
        print(endMarker)
        fflush(stdout)
        exit(success ? 0 : 1)
    }
}
