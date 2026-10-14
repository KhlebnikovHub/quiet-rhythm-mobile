import Capacitor

/// The editor is bundled in the app. This bridge exposes the system picker
/// used to save PNG images and library backups to a user-selected location.
final class BridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ExportFilePlugin())
    }
}
