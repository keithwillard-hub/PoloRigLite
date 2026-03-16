#!/usr/bin/env node
/*
 * WebSocket-to-UDP relay proxy.
 * Enables browser/desktop clients to communicate with the IC-705 via UDP.
 *
 * Usage: node udp-proxy.js [--port 8765]
 *
 * Client sends JSON: { action: 'create'|'send'|'close', id, host, port, data(base64) }
 * Server sends JSON: { id, data(base64) }
 */

const dgram = require('dgram')
const { WebSocketServer } = require('ws')

const port = parseInt(process.argv.find((a, i) => process.argv[i - 1] === '--port') || '8765', 10)

const wss = new WebSocketServer({ port })
console.log(`UDP proxy listening on ws://localhost:${port}`)

wss.on('connection', (ws) => {
  const sockets = new Map() // id -> dgram.Socket

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    const { action, id, host, port: destPort, data } = msg

    switch (action) {
      case 'create': {
        if (sockets.has(id)) return
        const sock = dgram.createSocket('udp4')
        sock.on('message', (buf) => {
          ws.send(JSON.stringify({ id, data: buf.toString('base64') }))
        })
        sock.on('error', (err) => {
          console.error(`Socket ${id} error:`, err.message)
        })
        sockets.set(id, sock)
        break
      }

      case 'send': {
        const sock = sockets.get(id)
        if (!sock || !data) return
        const buf = Buffer.from(data, 'base64')
        sock.send(buf, destPort, host)
        break
      }

      case 'close': {
        const sock = sockets.get(id)
        if (sock) {
          sock.close()
          sockets.delete(id)
        }
        break
      }
    }
  })

  ws.on('close', () => {
    for (const [id, sock] of sockets) {
      sock.close()
    }
    sockets.clear()
  })
})
