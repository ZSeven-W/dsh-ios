import SwiftUI

/// Full-screen surface: current preview + generation/footer chrome. The
/// footer doubles as the live status readout visible in the simulator
/// stream (generation counter, preview name, phase).
struct PreviewRootView: View {
  @ObservedObject var session: PreviewSession

  var body: some View {
    ZStack(alignment: .top) {
      Color.black.ignoresSafeArea()
      VStack(spacing: 0) {
        session.currentView
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        if !session.lastError.isEmpty {
          Text(session.lastError)
            .font(.caption2).foregroundColor(.orange)
            .lineLimit(2).multilineTextAlignment(.leading)
            .padding(6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.black.opacity(0.85))
        }
        footer
      }
    }
    .onAppear { session.start() }
  }

  private var footer: some View {
    HStack(spacing: 8) {
      Text("gen \(session.generation)")
        .monospacedDigit().padding(.horizontal, 6).padding(.vertical, 2)
        .background(Color(white: 0.22)).cornerRadius(4)
      if session.previews.count > 1 {
        Button(action: { session.step(-1) }) { Text("◀") }
        Text("\(session.index + 1)/\(session.previews.count)")
        Button(action: { session.step(1) }) { Text("▶") }
      }
      Text(session.previews.isEmpty ? "no previews" : session.previews[session.index].name)
        .lineLimit(1).truncationMode(.tail)
      Spacer()
      Text(session.phase)
    }
    .font(.caption).foregroundColor(.white)
    .padding(.horizontal, 10).padding(.vertical, 6)
    .background(Color(white: 0.12))
  }
}
