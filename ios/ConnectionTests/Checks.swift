import Foundation

struct APIError: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
}

/// Test-only collaborators for the production CanvasModel. The socket and
/// receive/retry loop are real; no live account or server is involved.
@MainActor
final class DoopClient {
    let server: ServerAddress
    let session: URLSession
    var dataHandler: ((String, String, [String: Any]?) async throws -> Data)?

    init(port: Int) {
        server = ServerAddress("https://127.0.0.1:\(port)")!
        session = URLSession(configuration: .ephemeral, delegate: LoopbackTrust(), delegateQueue: nil)
    }

    func request(_ path: String) throws -> URLRequest {
        URLRequest(url: URL(string: path, relativeTo: server.origin)!.absoluteURL)
    }

    func data(_ path: String, method: String, body: [String: Any]? = nil) async throws -> Data {
        guard let dataHandler else { throw URLError(.unsupportedURL) }
        return try await dataHandler(path, method, body)
    }

    func get<T: Decodable>(_ path: String) async throws -> T {
        preconditionFailure("Opening a canvas must not issue a redundant REST download")
    }
}

private final class LoopbackTrust: NSObject, URLSessionDelegate {
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.host == "127.0.0.1", let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }
}

@MainActor
final class AgentLiveActivities {
    static let shared = AgentLiveActivities()
    func observe(canvas: CanvasDocument?, tasks: [CanvasTask], client: DoopClient) {}
    func endCanvas(id: String, client: DoopClient) async {}
}

@main
struct ConnectionChecks {
    @MainActor static func main() async throws {
        let client = DoopClient(port: Int(CommandLine.arguments[1])!)
        defer { client.session.invalidateAndCancel() }
        let large = CanvasModel(id: "large", client: client)
        large.error = "Keep this unrelated save error"
        large.start()
        try await wait { large.connected }
        precondition(large.canvas!.frames[0].html.utf8.count > 1024 * 1024)
        precondition(large.connectionError == nil && large.error == "Keep this unrelated save error")
        // Cancel and immediately replace a receive; its catch must not alter
        // the replacement's connection status or leave a cancellation banner.
        for _ in 0..<20 {
            large.stop()
            large.start()
            try await wait { large.connected }
            try await Task.sleep(nanoseconds: 20_000_000)
            precondition(large.connected && large.connectionError == nil)
        }
        large.stop()
        try await Task.sleep(nanoseconds: 100_000_000)
        precondition(!large.connected && !large.connecting && large.connectionError == nil)

        let retry = CanvasModel(id: "retry", client: client)
        retry.start()
        try await wait { retry.connectionError != nil }
        try await wait { retry.connected }
        precondition(retry.canvas?.name == "Attempt 2" && retry.connectionError == nil)
        retry.stop()

        let malformed = CanvasModel(id: "malformed", client: client)
        malformed.start()
        try await wait { malformed.connectionError == CanvasSocket.Failure.invalidData.message }
        // A terminated run must release its task so an explicit restart works.
        malformed.connectionError = nil
        malformed.start()
        try await wait { malformed.connectionError == CanvasSocket.Failure.invalidData.message }
        precondition(!malformed.connected && !malformed.connecting)
        malformed.stop()

        let oversized = CanvasModel(id: "oversized", client: client)
        oversized.start()
        try await wait { oversized.connectionError == CanvasSocket.Failure.messageTooLarge.message }
        precondition(!oversized.connected && !oversized.connecting)
        // Wait past the transport retry delay and ask the fixture how many
        // joins it received: the permanent receive error must not reconnect.
        try await Task.sleep(nanoseconds: 2_500_000_000)
        let (attemptData, _) = try await client.session.data(for: client.request("/attempts/oversized"))
        let attempts = try JSONDecoder().decode(Int.self, from: attemptData)
        precondition(attempts == 1 && !oversized.connecting && !oversized.connected)
        oversized.stop()

        let missing = CanvasModel(id: "missing", client: client)
        missing.start()
        try await wait { missing.deleted }
        precondition(missing.connectionError == CanvasSocket.Failure.notFound.message)
        missing.stop()
        let comments = CanvasModel(id: "comments", client: client)
        comments.start()
        try await wait { comments.comments.count == 3 && comments.canvas?.name == "Still live" }
        precondition(comments.connected && comments.connectionError == nil)
        precondition(comments.comments.first { $0.id == "canvas-comment" }?.frameId == nil)
        precondition(comments.comments.first { $0.id == "reply" }?.parentId == "canvas-comment")
        precondition(comments.comments.first { $0.id == "canvas-comment" }?.resolvedAt == 20)
        comments.stop()
        try await checkEdits(client)
        print("Canvas connection integration checks passed (large init, 20 restarts, retry, invalid data, oversized receive, deleted canvas, live canvas comments and replies).")
    }

    @MainActor private static func checkEdits(_ client: DoopClient) async throws {
        let model = CanvasModel(id: "edits", client: client)
        model.canvas = try JSONDecoder().decode(CanvasDocument.self, from: Data(#"{"id":"edits","name":"Edits","frames":[],"pages":[{"id":"first-page","name":"First"},{"id":"design-page","name":"Design"}]}"#.utf8))
        model.connected = true
        var frames: [String: [String: Any]] = [:]
        var pages = model.canvas!.pages!
        var sequence = 0
        var failNext = false
        var apiFailure: APIError?
        var createBodies: [[String: Any]] = []
        var missingRequests = 0
        defer { client.dataHandler = nil }
        client.dataHandler = { path, method, body in
            // Undo cannot overtake a request that has not finished saving.
            precondition(!model.canUndo)
            try await Task.sleep(nanoseconds: 10_000_000)
            if failNext { failNext = false; throw URLError(.notConnectedToInternet) }
            if let failure = apiFailure { apiFailure = nil; throw failure }
            if path.hasSuffix("/comments") {
                return Data(#"{"id":"posted","frameId":"f1","from":"Tester","text":"Saved without a socket echo","at":30}"#.utf8)
            }
            let frameID = String(path.split(separator: "/").last!)
            var result: [String: Any] = [:]
            if method == "POST" {
                createBodies.append(body ?? [:])
                if let pageID = body?["pageId"] as? String, !pages.contains(where: { $0.id == pageID }) {
                    throw APIError(status: 400, message: "page not found")
                }
                sequence += 1
                result = body ?? [:]
                result["id"] = "f\(sequence)"; result["canvasId"] = "edits"
                result["pageId"] = body?["pageId"] ?? pages[0].id
                frames["f\(sequence)"] = result
            } else if method == "PATCH" {
                guard frames[frameID] != nil else {
                    missingRequests += 1
                    throw APIError(status: 404, message: "frame not found")
                }
                frames[frameID]!.merge(body ?? [:]) { _, new in new }
                result = frames[frameID]!
            } else if method == "DELETE" {
                guard frames.removeValue(forKey: frameID) != nil else {
                    missingRequests += 1
                    throw APIError(status: 404, message: "frame not found")
                }
            }
            return try JSONSerialization.data(withJSONObject: result)
        }
        await model.addFrame()
        precondition(model.canUndo && model.canvas?.frames.count == 1)
        let original = model.selected!
        try await model.patchFrame(original.id, patch: ["name": "Renamed"])
        // A collaborator changes an unrelated field: undo the local name only.
        frames[original.id]!["html"] = "<p>Collaborator edit</p>"
        let remote = try JSONSerialization.data(withJSONObject: ["type": "frame:updated", "frame": frames[original.id]!])
        model.apply(try JSONDecoder().decode(CanvasEvent.self, from: remote))
        failNext = true
        await model.undo()
        precondition(model.canUndo && model.selected?.name == "Renamed")
        await model.undo()
        precondition(model.selected?.name == original.name && model.selected?.html == "<p>Collaborator edit</p>")
        // A no-op save must not consume a later undo step.
        try await model.patchFrame(original.id, patch: ["name": original.name])
        failNext = true
        do {
            try await model.patchFrame(original.id, patch: ["name": "Must not be recorded"])
            preconditionFailure("Expected save failure")
        } catch {}
        await model.moveFrame(original.id, x: 120, y: 80)
        precondition(model.selected?.x == 120)
        await model.undo()
        precondition(model.selected?.x == original.x && model.selected?.y == original.y)
        frames[original.id]!["pageId"] = "design-page"
        frames[original.id]!["hidden"] = true
        frames[original.id]!["locked"] = true
        try await model.patchFrame(original.id, patch: ["name": "Before deleting"])
        try await model.deleteFrame(original.id)
        precondition(model.canvas?.frames.isEmpty == true)
        await model.undo()
        precondition(model.selected?.id == "f2" && model.selected?.name == "Before deleting")
        precondition(model.selected?.pageId == "design-page" && model.selected?.hidden == true && model.selected?.locked == true)
        await model.undo()
        precondition(model.selected?.name == original.name)
        await model.undo()
        precondition(model.canvas?.frames.isEmpty == true && !model.canUndo)
        await model.addFrame()
        await model.undo()
        failNext = true
        await model.addFrame()
        precondition(!model.canUndo, "A failed edit must not create undo history")
        try await model.comment("Saved without a socket echo", frameID: "f1")
        precondition(model.comments.count == 1)
        let echo = try JSONSerialization.data(withJSONObject: ["type": "comment", "comment": ["id": "posted", "frameId": "f1", "from": "Tester", "text": "Saved without a socket echo", "at": 30]])
        model.apply(try JSONDecoder().decode(CanvasEvent.self, from: echo))
        precondition(model.comments.count == 1)

        // A missing frame must not hide older edits, whether its deletion event
        // has already arrived or the REST response is the first confirmation.
        for receivedDelete in [false, true] {
            await model.addFrame()
            let older = model.selected!
            try await model.patchFrame(older.id, patch: ["name": "Older edit"])
            await model.addFrame()
            let missingID = model.selected!.id
            try await model.patchFrame(missingID, patch: ["name": "First edit"])
            try await model.patchFrame(missingID, patch: ["name": "Second edit"])
            frames.removeValue(forKey: missingID)
            if receivedDelete {
                try apply(["type": "frame:deleted", "frameId": missingID], to: model)
            }
            model.error = nil
            let beforeRequests = missingRequests
            await model.undo()
            precondition(model.selected?.id == older.id && model.selected?.name == older.name)
            precondition(model.error == nil && model.canvas?.frames.count == 1)
            await model.undo()
            precondition(!model.canUndo && frames.isEmpty && model.canvas?.frames.isEmpty == true)
            precondition(missingRequests == beforeRequests + 1, "Discard all obsolete edits for the missing frame")
        }
        // Undoing a creation that a collaborator already deleted is also done.
        await model.addFrame()
        frames.removeValue(forKey: model.selected!.id)
        await model.undo()
        precondition(!model.canUndo && model.selectedID == nil && model.canvas?.frames.isEmpty == true)

        await model.addFrame()
        let retryFrame = model.selected!
        try await model.patchFrame(retryFrame.id, patch: ["name": "Retry this edit"])
        for status in [401, 403, 500, 503] {
            apiFailure = APIError(status: status, message: "Retry after access or server recovery")
            await model.undo()
            precondition(model.canUndo && model.selected?.name == "Retry this edit")
        }
        await model.undo()
        precondition(model.selected?.name == retryFrame.name)
        await model.undo()
        precondition(!model.canUndo && frames.isEmpty)

        // Restore after the web client removes the original page. Cover both
        // the live page event and a delayed event that races with the POST.
        let originalPages = pages
        for receivedPages in [true, false] {
            pages = originalPages
            try apply(["type": "canvas:pages", "pages": pages.map { ["id": $0.id, "name": $0.name] }], to: model)
            await model.addFrame()
            let deletedID = model.selected!.id
            frames[deletedID]!["pageId"] = "design-page"
            try await model.patchFrame(deletedID, patch: ["name": "Restore this frame"])
            try await model.deleteFrame(deletedID)
            pages.removeAll { $0.id == "design-page" }
            if receivedPages {
                try apply(["type": "canvas:pages", "pages": pages.map { ["id": $0.id, "name": $0.name] }], to: model)
                precondition(model.canvas?.pages?.map(\.id) == ["first-page"])
            }
            model.error = nil
            let beforeCreates = createBodies.count
            await model.undo()
            precondition(model.selected?.name == "Restore this frame" && model.selected?.pageId == "first-page")
            precondition(model.error == nil && frames.count == 1)
            if receivedPages {
                precondition(createBodies.count == beforeCreates + 1)
                precondition(createBodies.last?["pageId"] as? String == "first-page")
            } else {
                precondition(createBodies.count == beforeCreates + 2)
                precondition(createBodies.last?["pageId"] == nil, "Let the server choose an existing page after a stale-page rejection")
            }
            await model.undo()
            precondition(model.selected?.name == "Untitled frame", "Older edits must follow the restored frame on its new page")
            await model.undo()
            precondition(!model.canUndo && frames.isEmpty)
        }
        // A 404 while restoring refers to the canvas, not an obsolete frame edit.
        await model.addFrame()
        try await model.deleteFrame(model.selected!.id)
        apiFailure = APIError(status: 404, message: "not found")
        await model.undo()
        precondition(model.canUndo && frames.isEmpty)
        await model.undo()
        precondition(model.canvas?.frames.count == 1)
        await model.undo()
        precondition(!model.canUndo && frames.isEmpty)
        print("Canvas edit checks passed (undo create/edit/move/delete, ID remapping, failed saves, retry, collaborator fields, comment post/echo).")
        print("Collaborative undo checks passed (deleted frames, deleted pages, delayed page events, access/server failure retry, failed restoration).")
    }

    @MainActor private static func apply(_ event: [String: Any], to model: CanvasModel) throws {
        let data = try JSONSerialization.data(withJSONObject: event)
        model.apply(try JSONDecoder().decode(CanvasEvent.self, from: data))
    }

    @MainActor private static func wait(_ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(10)
        while !condition() {
            precondition(Date() < deadline, "Timed out waiting for canvas connection")
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }
}
