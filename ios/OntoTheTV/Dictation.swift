import AVFoundation
import Foundation
import Speech

/// Mic dictation into the search field. Partial transcripts replace the field.
@MainActor
final class Dictation {
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var tapped = false
    private var stopping = false
    private var onText: ((String) -> Void)?
    private var onFailure: ((String) -> Void)?
    private var onEnd: (() -> Void)?

    var listening: Bool { request != nil && !stopping }

    func start(text: @escaping (String) -> Void, failure: @escaping (String) -> Void, ended: @escaping () -> Void) {
        onText = text
        onFailure = failure
        onEnd = ended
        stopping = false
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            Task { @MainActor in
                guard let self else { return }
                guard status == .authorized else {
                    self.onFailure?("speech off")
                    self.onEnd?()
                    return
                }
                AVAudioApplication.requestRecordPermission { [weak self] granted in
                    Task { @MainActor in
                        guard let self else { return }
                        guard granted else {
                            self.onFailure?("mic off")
                            self.onEnd?()
                            return
                        }
                        self.begin()
                    }
                }
            }
        }
    }

    func stop() {
        guard request != nil || tapped || engine.isRunning else { return }
        stopping = true
        if tapped {
            engine.inputNode.removeTap(onBus: 0)
            tapped = false
        }
        engine.stop()
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func begin() {
        guard !stopping else { return }
        let recognizer = SFSpeechRecognizer() ?? SFSpeechRecognizer(locale: Locale(identifier: "en-AU"))
        guard let recognizer, recognizer.isAvailable else {
            onFailure?("speech off")
            onEnd?()
            return
        }
        let recognition = SFSpeechAudioBufferRecognitionRequest()
        recognition.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition {
            recognition.requiresOnDeviceRecognition = true
        }
        request = recognition
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                throw TVProblem(line: "mic off")
            }
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                recognition.append(buffer)
            }
            tapped = true
            engine.prepare()
            try engine.start()
        } catch {
            stop()
            onFailure?("mic off")
            onEnd?()
            return
        }
        task = recognizer.recognitionTask(with: recognition) { [weak self] result, error in
            Task { @MainActor in
                guard let self, !self.stopping else { return }
                if let result {
                    self.onText?(result.bestTranscription.formattedString)
                }
                if error != nil || result?.isFinal == true {
                    self.stop()
                    if error != nil && result == nil { self.onFailure?("speech off") }
                    self.onEnd?()
                }
            }
        }
    }
}
