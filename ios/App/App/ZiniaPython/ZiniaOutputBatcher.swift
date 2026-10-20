import Foundation

/// Coalesces Python output into a few events per second.
///
/// Python calls back once per `write()`; forwarding each call to the WebView
/// separately would flood the JavaScript bridge. Chunks are merged per
/// execution and stream, then delivered on the main thread at most every
/// `interval` seconds (or sooner when a lot of text is pending).
final class ZiniaOutputBatcher {
    typealias Deliver = ([[String: Any]]) -> Void

    private struct Chunk {
        let executionId: String
        let stream: String
        var text: String
    }

    private let queue = DispatchQueue(label: "com.ziniapython.output-batcher")
    private let interval: TimeInterval
    private let maxPendingCharacters: Int
    private let deliver: Deliver
    private var pending: [Chunk] = []
    private var pendingCharacters = 0
    private var flushScheduled = false

    init(interval: TimeInterval = 0.05, maxPendingCharacters: Int = 32_000, deliver: @escaping Deliver) {
        self.interval = interval
        self.maxPendingCharacters = maxPendingCharacters
        self.deliver = deliver
    }

    func append(executionId: String, stream: String, text: String) {
        queue.async {
            if var last = self.pending.last, last.executionId == executionId, last.stream == stream {
                last.text += text
                self.pending[self.pending.count - 1] = last
            } else {
                self.pending.append(Chunk(executionId: executionId, stream: stream, text: text))
            }
            self.pendingCharacters += text.utf16.count
            if self.pendingCharacters >= self.maxPendingCharacters {
                self.flushLocked()
            } else if !self.flushScheduled {
                self.flushScheduled = true
                self.queue.asyncAfter(deadline: .now() + self.interval) { self.flushLocked() }
            }
        }
    }

    /// Delivers everything pending, then runs `then` on the main thread.
    /// Because both hops go through the main queue in order, `then` always
    /// observes all output appended before `flush` was called.
    func flush(then: @escaping () -> Void) {
        queue.async {
            self.flushLocked()
            DispatchQueue.main.async(execute: then)
        }
    }

    private func flushLocked() {
        flushScheduled = false
        guard !pending.isEmpty else { return }
        let chunks = pending.map { ["executionId": $0.executionId, "stream": $0.stream, "text": $0.text] as [String: Any] }
        pending.removeAll(keepingCapacity: true)
        pendingCharacters = 0
        DispatchQueue.main.async { self.deliver(chunks) }
    }
}
