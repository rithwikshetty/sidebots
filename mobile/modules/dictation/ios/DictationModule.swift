import AVFoundation
import ExpoModulesCore
import Speech

final class UnavailableException: Exception, @unchecked Sendable {
  override var reason: String { "Dictation needs iOS 26 or later." }
}

final class UnsupportedLanguageException: Exception, @unchecked Sendable {
  override var reason: String { "Dictation doesn't support any of your phone's languages yet." }
}

/// Apple's speech model, which runs on the phone, so the recording never
/// leaves it. `prepare` picks the first of the phone's languages the model
/// knows and downloads that language once; `transcribe` turns a recording
/// into text in it.
public final class DictationModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Dictation")

    Function("isAvailable") { () -> Bool in
      if #available(iOS 26, *) { return SpeechTranscriber.isAvailable }
      return false
    }

    AsyncFunction("prepare") { () async throws -> String in
      guard #available(iOS 26, *) else { throw UnavailableException() }
      return try await Self.prepare()
    }

    AsyncFunction("transcribe") { (url: URL, locale: String) async throws -> String in
      guard #available(iOS 26, *) else { throw UnavailableException() }
      return try await Self.transcribe(url, locale: Locale(identifier: locale))
    }
  }

  @available(iOS 26, *)
  private static func transcriber(for locale: Locale) -> SpeechTranscriber {
    let preset = SpeechTranscriber.Preset.transcription
    return SpeechTranscriber(
      locale: locale,
      transcriptionOptions: preset.transcriptionOptions,
      reportingOptions: preset.reportingOptions,
      attributeOptions: preset.attributeOptions
    )
  }

  /// The person's languages in the order Settings lists them, then the phone's region.
  @available(iOS 26, *)
  private static func prepare() async throws -> String {
    for language in Locale.preferredLanguages + [Locale.current.identifier] {
      guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language)) else { continue }
      // Nil once the language is on the phone.
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber(for: locale)]) {
        try await request.downloadAndInstall()
      }
      return locale.identifier
    }
    throw UnsupportedLanguageException()
  }

  @available(iOS 26, *)
  private static func transcribe(_ url: URL, locale: Locale) async throws -> String {
    let module = transcriber(for: locale)
    let analyzer = SpeechAnalyzer(modules: [module])
    let file = try AVAudioFile(forReading: url)
    // The results end once the analyzer finishes, so collecting them settles after it.
    async let sentences = module.results.reduce(into: [String]()) { sentences, result in
      if result.isFinal { sentences.append(String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)) }
    }
    do {
      if let end = try await analyzer.analyzeSequence(from: file) {
        try await analyzer.finalizeAndFinish(through: end)
      } else {
        await analyzer.cancelAndFinishNow()
      }
    } catch {
      await analyzer.cancelAndFinishNow()
      throw error
    }
    return try await sentences.filter { !$0.isEmpty }.joined(separator: " ")
  }
}
