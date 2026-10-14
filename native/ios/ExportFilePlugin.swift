import Foundation
import UIKit
import Capacitor

/// Exports a generated cache file through the system Files picker without moving the source.
@objc(ExportFilePlugin)
public class ExportFilePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    public let identifier = "ExportFilePlugin"
    public let jsName = "ExportFile"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise)
    ]
    private var pendingCall: CAPPluginCall?
    private weak var activePicker: UIDocumentPickerViewController?

    @objc func save(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.pendingCall == nil else {
                call.reject("Дождитесь завершения текущего экспорта.", "EXPORT_BUSY")
                return
            }
            do {
                let source = try self.validatedSource(call)
                guard let controller = self.bridge?.viewController,
                      controller.viewIfLoaded?.window != nil,
                      controller.presentedViewController == nil else {
                    call.reject("Закройте другое системное окно и повторите сохранение.", "EXPORT_PICKER_BUSY")
                    return
                }
                let picker = UIDocumentPickerViewController(forExporting: [source], asCopy: true)
                picker.delegate = self
                picker.modalPresentationStyle = .formSheet
                self.pendingCall = call
                self.activePicker = picker
                controller.present(picker, animated: true) {
                    picker.presentationController?.delegate = self
                }
            } catch {
                call.reject("Некорректный файл для экспорта.", "EXPORT_INVALID_SOURCE", error)
            }
        }
    }

    private func validatedSource(_ call: CAPPluginCall) throws -> URL {
        func invalid() -> NSError { NSError(domain: "ExportFile", code: 1, userInfo: [NSLocalizedDescriptionKey: "Source must be a generated app cache export."]) }
        guard let value = call.getString("source"), let suppliedURL = URL(string: value),
              suppliedURL.isFileURL, suppliedURL.host == nil || suppliedURL.host == "",
              suppliedURL.query == nil, suppliedURL.fragment == nil,
              let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first,
              let name = call.getString("name"), let mime = call.getString("mime") else { throw invalid() }
        let cacheRoot = cache.standardizedFileURL.resolvingSymlinksInPath()
        let exports = cacheRoot.appendingPathComponent("exports", isDirectory: true).resolvingSymlinksInPath()
        let source = suppliedURL.standardizedFileURL.resolvingSymlinksInPath()
        let extensionByMime = ["image/png": ".png", "application/json": ".json", "text/plain": ".txt"]
        guard let suffix = extensionByMime[mime], name.lowercased().hasSuffix(suffix),
              name == source.lastPathComponent, name.count <= 110,
              !name.contains("/"), !name.contains("\\"),
              name.rangeOfCharacter(from: .controlCharacters) == nil,
              exports.path.hasPrefix(cacheRoot.path + "/"), source.path.hasPrefix(exports.path + "/") else { throw invalid() }
        let properties = try source.resourceValues(forKeys: [.isRegularFileKey, .isReadableKey])
        guard properties.isRegularFile == true, properties.isReadable == true else { throw invalid() }
        return source
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard controller === activePicker else { return }
        finish(saved: !urls.isEmpty)
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard controller === activePicker else { return }
        finish(saved: false)
    }

    public func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        guard presentationController.presentedViewController === activePicker else { return }
        finish(saved: false)
    }

    private func finish(saved: Bool) {
        let call = pendingCall
        pendingCall = nil
        activePicker = nil
        call?.resolve(["saved": saved])
    }
}
