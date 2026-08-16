import SwiftUI
import Darwin

/// One preview variant inside a loaded dylib.
struct PreviewItem: Identifiable {
  let id: Int
  let name: String
}

/// Box that crosses the C ABI between the host and the hot-swapped dylib.
/// The dylib owns an identical-layout class; only the AnyView value payload
/// is shared through the raw pointer.
final class ViewBox {
  let view: AnyView
  init(_ view: AnyView) { self.view = view }
}

/// A hot-swapped dylib currently loaded into the host process.
final class LoadedLibrary {
  let handle: UnsafeMutableRawPointer
  let generation: Int
  let items: [PreviewItem]
  private let makeView: @convention(c) (Int) -> UnsafeMutableRawPointer

  init?(handle: UnsafeMutableRawPointer, generation: Int) {
    guard let countSymbol = dlsym(handle, "dsh_preview_count") else { return nil }
    guard let nameSymbol = dlsym(handle, "dsh_preview_name") else { return nil }
    guard let makeSymbol = dlsym(handle, "dsh_preview_make_view") else { return nil }
    let count = unsafeBitCast(countSymbol, to: (@convention(c) () -> Int).self)()
    // count == 0 is a valid generation ("no previews"): the root view shows
    // its waiting placeholder instead of rejecting the dylib.
    let name = unsafeBitCast(nameSymbol, to: (@convention(c) (Int) -> UnsafePointer<CChar>?).self)
    let items = (0 ..< max(0, count)).map { index -> PreviewItem in
      let cname = name(index)
      let display = cname.map { String(cString: $0) } ?? "preview \(index)"
      return PreviewItem(id: index, name: display)
    }
    self.handle = handle
    self.generation = generation
    self.items = items
    self.makeView = unsafeBitCast(makeSymbol, to: (@convention(c) (Int) -> UnsafeMutableRawPointer).self)
  }

  func view(for index: Int) -> AnyView {
    let raw = makeView(max(0, min(index, items.count - 1)))
    return Unmanaged<ViewBox>.fromOpaque(raw).takeRetainedValue().view
  }
}

/// Owns the hot-swap loop: polls the drop directory for a new manifest,
/// dlopens the numbered dylib it names, swaps the displayed view, and
/// reports its state back through result.json (read by the plugin from the
/// Mac side of the container).
@MainActor
final class PreviewSession: ObservableObject {
  @Published var generation = 0
  @Published var previews: [PreviewItem] = []
  @Published var index = 0
  @Published var lastError = ""
  @Published var phase = "waiting"

  private var library: LoadedLibrary?
  private var dropDirectory: URL?
  private var timer: Timer?
  /// Loaded dylib handles are intentionally never dlclosed: SwiftUI's diff
  /// machinery still references the previous view value's metadata after a
  /// swap, so unloading the module would leave dangling type references.
  /// Dev-preview hosts leak small handles by design instead of crashing.
  private var retainedHandles: [UnsafeMutableRawPointer] = []

  func start() {
    guard let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
      lastError = "document directory unavailable"
      return
    }
    let directory = docs.appendingPathComponent("dsh-preview-drop", isDirectory: true)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    dropDirectory = directory
    writeResult()
    poll()
    let timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
      Task { @MainActor [weak self] in self?.poll() }
    }
    timer.tolerance = 0.2
    self.timer = timer
  }

  func poll() {
    guard let directory = dropDirectory else { return }
    let manifestURL = directory.appendingPathComponent("manifest.json")
    guard let data = try? Data(contentsOf: manifestURL),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let nextGeneration = object["generation"] as? Int,
          nextGeneration > generation else {
      return
    }
    let dylibName = object["dylib"] as? String ?? ""
    let dylibURL = directory.appendingPathComponent(dylibName)
    if let handle = dlopen(dylibURL.path, RTLD_NOW),
       let loaded = LoadedLibrary(handle: handle, generation: nextGeneration) {
      retainedHandles.append(handle)
      library = loaded
      generation = nextGeneration
      previews = loaded.items
      index = 0
      lastError = ""
      phase = "hot-swap"
    } else {
      lastError = dlerror().map { String(cString: $0) } ?? "failed to load \(dylibName)"
      phase = "stale"
    }
    writeResult()
  }

  var currentView: AnyView {
    guard let library = library, !library.items.isEmpty else {
      return AnyView(
        Text("Waiting for preview dylib…")
          .font(.title3).foregroundColor(.white.opacity(0.7))
      )
    }
    let safeIndex = max(0, min(index, library.items.count - 1))
    return library.view(for: safeIndex)
  }

  func step(_ delta: Int) {
    guard !previews.isEmpty else { return }
    index = (index + delta + previews.count) % previews.count
  }

  private func writeResult() {
    guard let directory = dropDirectory else { return }
    let payload: [String: Any] = [
      "generation": generation,
      "previews": previews.map(\.name),
      "error": lastError,
      "phase": phase,
      "pid": ProcessInfo.processInfo.processIdentifier,
      "updatedAt": Int(Date().timeIntervalSince1970),
    ]
    let url = directory.appendingPathComponent("result.json")
    if let data = try? JSONSerialization.data(withJSONObject: payload) {
      try? data.write(to: url, options: .atomic)
    }
  }
}
