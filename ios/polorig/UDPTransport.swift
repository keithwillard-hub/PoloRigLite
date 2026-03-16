import Foundation
import Network

/// Thin native module for UDP socket I/O. No protocol knowledge — just bytes in, bytes out.
/// Sends/receives data as base64 strings across the React Native bridge.
@objc(UDPTransport)
class UDPTransport: RCTEventEmitter {
    private var sockets: [String: NWConnection] = [:]
    private let queue = DispatchQueue(label: "com.ac0vw.polorig.udptransport", qos: .userInitiated)
    private var hasListeners = false

    override static func requiresMainQueueSetup() -> Bool { false }

    override func supportedEvents() -> [String]! {
        ["onUDPData"]
    }

    override func startObserving() { hasListeners = true }
    override func stopObserving() { hasListeners = false }

    // MARK: - Create Socket

    @objc func createSocket(_ id: String,
                            resolver resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
        queue.async { [weak self] in
            // Close existing socket with same id if any
            self?.sockets[id]?.cancel()
            self?.sockets.removeValue(forKey: id)
            resolve(nil)
        }
    }

    // MARK: - Send

    @objc func send(_ id: String, host: String, port: Int,
                    base64Data: String,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let data = Data(base64Encoded: base64Data) else {
            reject("INVALID_DATA", "Invalid base64 data", nil)
            return
        }

        queue.async { [weak self] in
            guard let self else { return }

            let connection: NWConnection
            if let existing = self.sockets[id], existing.state != .cancelled {
                connection = existing
            } else {
                // Remove stale cancelled connection if any
                self.sockets[id]?.cancel()
                self.sockets.removeValue(forKey: id)
                // Create connection on first send
                let nwHost = NWEndpoint.Host(host)
                guard let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else {
                    reject("INVALID_PORT", "Invalid port", nil)
                    return
                }
                let conn = NWConnection(host: nwHost, port: nwPort, using: .udp)
                conn.stateUpdateHandler = { state in
                    if case .failed(let error) = state {
                        print("UDPTransport [\(id)] failed: \(error)")
                    }
                }
                conn.start(queue: self.queue)
                self.sockets[id] = conn
                self.startReceiving(id: id, connection: conn)
                connection = conn
            }

            connection.send(content: data, completion: .contentProcessed { error in
                if let error {
                    // Log but still resolve — UDP sends are best-effort.
                    // Rejecting here causes uncaught promise errors since
                    // callers fire-and-forget most sends.
                    print("UDPTransport [\(id)] send error: \(error)")
                }
                resolve(nil)
            })
        }
    }

    // MARK: - Close

    @objc func close(_ id: String,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        queue.async { [weak self] in
            self?.sockets[id]?.cancel()
            self?.sockets.removeValue(forKey: id)
            resolve(nil)
        }
    }

    // MARK: - Receive

    private func startReceiving(id: String, connection: NWConnection) {
        connection.receiveMessage { [weak self] content, _, _, error in
            guard let self else { return }
            if let data = content, !data.isEmpty, self.hasListeners {
                let b64 = data.base64EncodedString()
                DispatchQueue.main.async {
                    self.sendEvent(withName: "onUDPData", body: ["id": id, "data": b64])
                }
            }
            // Keep receiving unless connection was cancelled
            if error == nil, connection.state != .cancelled {
                self.startReceiving(id: id, connection: connection)
            }
        }
    }

    deinit {
        for (_, conn) in sockets {
            conn.cancel()
        }
    }
}
