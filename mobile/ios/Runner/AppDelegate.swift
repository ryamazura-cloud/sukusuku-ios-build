import AVKit
import Flutter
import ImageIO
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    let app = FlutterMethodChannel(
      name: "biz.wisemap.family_share/app",
      binaryMessenger: engineBridge.applicationRegistrar.messenger()
    )
    app.setMethodCallHandler { call, result in
      guard call.method == "buildNumber" else {
        result(FlutterMethodNotImplemented)
        return
      }
      let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
      result(version.flatMap { Int($0) })
    }
    let metadata = FlutterMethodChannel(
      name: "biz.wisemap.family_share/metadata",
      binaryMessenger: engineBridge.applicationRegistrar.messenger()
    )
    metadata.setMethodCallHandler { call, result in
      guard call.method == "captureDate" else {
        result(FlutterMethodNotImplemented)
        return
      }
      guard let args = call.arguments as? [String: Any], let path = args["path"] as? String else {
        result(nil)
        return
      }
      let url = URL(fileURLWithPath: path)
      let video = args["video"] as? Bool == true
      Task.detached {
        let date = await captureDate(url, video: video)
        await MainActor.run { result(date) }
      }
    }
    let channel = FlutterMethodChannel(
      name: "biz.wisemap.family_share/video",
      binaryMessenger: engineBridge.applicationRegistrar.messenger()
    )
    channel.setMethodCallHandler { call, result in
      if call.method == "temporaryDirectory" {
        result(NSTemporaryDirectory())
        return
      }
      guard call.method == "open" else {
        result(FlutterMethodNotImplemented)
        return
      }

      guard let path = call.arguments as? String else {
        result(FlutterError(code: "video_unavailable", message: nil, details: nil))
        return
      }
      let file = URL(fileURLWithPath: path).resolvingSymlinksInPath()
      let temp = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true).resolvingSymlinksInPath()
      let prefix = temp.path.hasSuffix("/") ? temp.path : temp.path + "/"
      guard file.path.hasPrefix(prefix),
        FileManager.default.isReadableFile(atPath: file.path),
        let window = UIApplication.shared.connectedScenes
          .compactMap({ $0 as? UIWindowScene })
          .filter({ $0.activationState == .foregroundActive })
          .flatMap(\.windows)
          .first(where: \.isKeyWindow),
        let presenter = window.rootViewController,
        presenter.presentedViewController == nil
      else {
        result(FlutterError(code: "video_unavailable", message: nil, details: nil))
        return
      }

      let screen = SukusukuVideoScreen(file: file, result: result)
      let navigation = UINavigationController(rootViewController: screen)
      navigation.modalPresentationStyle = .fullScreen
      presenter.present(navigation, animated: true)
    }
  }
}

private func captureDate(_ url: URL, video: Bool) async -> String? {
  if video {
    let asset = AVURLAsset(url: url)
    if #available(iOS 15.0, *) {
      guard let item = try? await asset.load(.creationDate) else { return nil }
      if let value = try? await item.load(.stringValue) { return value }
      if let value = try? await item.load(.dateValue) {
        return ISO8601DateFormatter().string(from: value)
      }
      return nil
    }
    return asset.creationDate?.stringValue
  }
  guard
    let source = CGImageSourceCreateWithURL(url as CFURL, nil),
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
    let exif = properties[kCGImagePropertyExifDictionary as String] as? [String: Any]
  else { return nil }
  return exif[kCGImagePropertyExifDateTimeOriginal as String] as? String
}

private final class SukusukuVideoScreen: UIViewController {
  private let playback = AVPlayerViewController()
  private var result: FlutterResult?

  init(file: URL, result: @escaping FlutterResult) {
    self.result = result
    super.init(nibName: nil, bundle: nil)
    playback.player = AVPlayer(url: file)
  }

  required init?(coder: NSCoder) { return nil }

  override func viewDidLoad() {
    super.viewDidLoad()
    title = "動画"
    view.backgroundColor = .black
    navigationItem.rightBarButtonItem = UIBarButtonItem(
      title: "閉じる", style: .done, target: self, action: #selector(closePlayback)
    )
    addChild(playback)
    view.addSubview(playback.view)
    playback.view.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      playback.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      playback.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      playback.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      playback.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
    playback.didMove(toParent: self)
  }

  @objc private func closePlayback() {
    playback.player?.pause()
    let completion = result
    result = nil
    dismiss(animated: true) { completion?(nil) }
  }
}
