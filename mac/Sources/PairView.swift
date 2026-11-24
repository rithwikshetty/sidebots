import CoreImage.CIFilterBuiltins
import SwiftUI

/// The window with the QR code a phone scans to pair. It makes a new code when
/// the last one runs out, and says when a phone has paired.
struct PairView: View {
  let server: Server
  let done: () -> Void

  @State private var pairing: Pairing?
  @State private var problem: String?
  @State private var paired: Phone?
  @State private var copied = false

  var body: some View {
    VStack(spacing: 18) {
      if let paired {
        success(paired)
      } else {
        VStack(spacing: 8) {
          Text("Pair your phone").font(.title2.bold())
          Text("Open Sidebots on your phone and point its camera at this code.")
            .multilineTextAlignment(.center)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        code
        Text("No Sidebots on your phone yet? Get it from the App Store.")
          .font(.callout)
          .multilineTextAlignment(.center)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(28)
    .frame(width: 400)
    .task(id: paired == nil) { if paired == nil { await watch() } }
  }

  @ViewBuilder private var code: some View {
    if let pairing, let image = qrCode(pairing.link) {
      VStack(spacing: 12) {
        Image(nsImage: image)
          .interpolation(.none)
          .resizable()
          .frame(width: 220, height: 220)
          .padding(14)
          .background(RoundedRectangle(cornerRadius: 14).fill(.white))
        HStack(spacing: 8) {
          Text(pairing.link)
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
            .textSelection(.enabled)
          Button(copied ? "Copied" : "Copy link") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(pairing.link, forType: .string)
            copied = true
          }
          .controlSize(.small)
        }
      }
    } else {
      VStack(spacing: 10) {
        ProgressView().controlSize(.small)
        Text(problem ?? "Getting this computer ready for your phone. This needs an internet connection.")
          .multilineTextAlignment(.center)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(width: 248, height: 248)
    }
  }

  private func success(_ phone: Phone) -> some View {
    VStack(spacing: 14) {
      Image(systemName: "checkmark.circle.fill").font(.system(size: 52)).foregroundStyle(.green)
      Text("Paired with \(phone.name)").font(.title2.bold()).multilineTextAlignment(.center)
      Text("Your agents are on your phone now. Sidebots keeps running in the menu bar, at the top of the screen.")
        .multilineTextAlignment(.center)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      HStack {
        Button("Pair another phone") { paired = nil }
        Button("Done", action: done).keyboardShortcut(.defaultAction)
      }
      .padding(.top, 4)
    }
  }

  /// Keeps a fresh code on screen and watches for a phone to pair with it.
  private func watch() async {
    pairing = nil
    copied = false
    await server.readPhones()
    let before = Set(server.phones.map(\.id))
    while !Task.isCancelled {
      if let phone = server.phones.first(where: { !before.contains($0.id) }) {
        paired = phone
        return
      }
      // A computer gets the address phones reach it at from the relay, once it is online. It can't make a code before then.
      if server.status?.address == nil { await server.readStatus() }
      let expired = pairing.map { $0.expiresAt <= Date.now.timeIntervalSince1970 * 1000 } ?? true
      if server.status?.address != nil, expired {
        do {
          pairing = try await server.pair()
          problem = nil
          copied = false
        } catch {
          pairing = nil
          problem = error.localizedDescription
        }
      }
      try? await Task.sleep(for: .seconds(2))
      await server.readPhones()
    }
  }

  /// The link as a QR code, scaled up with sharp edges, since the filter draws one pixel to a square.
  private func qrCode(_ link: String) -> NSImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(link.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage?.samplingNearest().transformed(by: CGAffineTransform(scaleX: 12, y: 12)),
      let image = CIContext().createCGImage(output, from: output.extent)
    else { return nil }
    return NSImage(cgImage: image, size: output.extent.size)
  }
}
