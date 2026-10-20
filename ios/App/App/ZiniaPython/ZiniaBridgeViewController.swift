import UIKit
import Capacitor

/// The app's root view controller. It is Capacitor's bridge view controller
/// plus registration of ZiniaPython's two in-app plugins. Plugins that live in
/// npm packages are discovered automatically; plugins compiled into the app
/// target must be registered here (https://capacitorjs.com/docs/ios/custom-code).
class ZiniaBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ZiniaPythonPlugin())
        bridge?.registerPluginInstance(ZiniaFilesPlugin())
    }
}
