import { OperationQueue } from '../protocol/OperationQueue'
import { TimeoutError, OperationCancelledError } from '../protocol/RadioError'

describe('OperationQueue', () => {
  let queue
  let sentCIV, flushed, suspended, resumed

  beforeEach(() => {
    jest.useFakeTimers()
    sentCIV = []
    flushed = 0
    suspended = 0
    resumed = 0

    queue = new OperationQueue({
      onSendCIV: (frame, opts) => sentCIV.push({ frame, opts }),
      onFlush: () => flushed++,
      onSuspendTraffic: () => suspended++,
      onResumeTraffic: () => resumed++
    })
  })

  afterEach(() => {
    queue.destroy()
    jest.useRealTimers()
  })

  describe('basic operation lifecycle', () => {
    it('starts with no active operation', () => {
      expect(queue.isActive).toBe(false)
      expect(queue.activeType).toBeNull()
      expect(queue.depth).toBe(0)
    })

    it('status operation sends frequency + mode requests', () => {
      queue.enqueue('status').catch(() => {})
      expect(queue.isActive).toBe(true)
      expect(queue.activeType).toBe('status')
      expect(sentCIV.length).toBe(2) // readFrequency + readMode
    })

    it('cwSpeed operation sends speed request', () => {
      queue.enqueue('cwSpeed').catch(() => {})
      expect(sentCIV.length).toBe(1)
      expect(queue.activeType).toBe('cwSpeed')
    })

    it('cwSpeedWarmup sends freq + mode + speed', () => {
      queue.enqueue('cwSpeedWarmup').catch(() => {})
      expect(sentCIV.length).toBe(3)
    })

    it('setCWSpeed sends set speed command', () => {
      queue.enqueue('setCWSpeed', 25).catch(() => {})
      expect(sentCIV.length).toBe(1)
    })
  })

  describe('state accumulation', () => {
    it('status completes when both frequency and mode arrive', async () => {
      const promise = queue.enqueue('status')
      let resolved = false
      let result = null
      promise.then(r => { resolved = true; result = r })

      // Feed frequency
      queue.handleResponse('frequency', 14060000)
      await Promise.resolve()
      expect(resolved).toBe(false) // not yet — need mode too

      // Feed mode
      queue.handleResponse('mode', 'CW')
      await Promise.resolve()
      expect(resolved).toBe(true)
      expect(result).toEqual({ frequency: 14060000, mode: 'CW' })
    })

    it('cwSpeedWarmup completes when freq + mode + speed arrive', async () => {
      const promise = queue.enqueue('cwSpeedWarmup')
      let result = null
      promise.then(r => { result = r })

      queue.handleResponse('frequency', 7074000)
      queue.handleResponse('mode', 'USB')
      await Promise.resolve()
      expect(result).toBeNull()

      queue.handleResponse('cwSpeed', 20)
      await Promise.resolve()
      expect(result).toEqual({ frequency: 7074000, mode: 'USB', cwSpeed: 20 })
    })

    it('cwSpeed completes when speed arrives', async () => {
      const promise = queue.enqueue('cwSpeed')
      let result = null
      promise.then(r => { result = r })

      queue.handleResponse('cwSpeed', 30)
      await Promise.resolve()
      expect(result).toEqual({ cwSpeed: 30 })
    })
  })

  describe('serialization', () => {
    it('queues second operation behind first', () => {
      queue.enqueue('status').catch(() => {})
      queue.enqueue('cwSpeed').catch(() => {})
      expect(queue.depth).toBe(1) // cwSpeed queued
      expect(queue.activeType).toBe('status')
    })

    it('processes next after first completes', async () => {
      const p1 = queue.enqueue('status')
      const p2 = queue.enqueue('cwSpeed').catch(() => {})

      // Complete status
      queue.handleResponse('frequency', 14060000)
      queue.handleResponse('mode', 'CW')
      await p1

      // Now cwSpeed should be active
      expect(queue.activeType).toBe('cwSpeed')
    })
  })

  describe('timeouts', () => {
    it('status times out after 12s', async () => {
      let error = null
      const promise = queue.enqueue('status').catch(e => { error = e })

      jest.advanceTimersByTime(12100)
      await Promise.resolve()
      await Promise.resolve()

      expect(error).toBeInstanceOf(TimeoutError)
      expect(error.operation).toBe('status')
      expect(error.duration).toBe(12000)
    })

    it('cwSpeed times out after 10s', async () => {
      let error = null
      const promise = queue.enqueue('cwSpeed').catch(e => { error = e })

      jest.advanceTimersByTime(10100)
      await Promise.resolve()
      await Promise.resolve()

      expect(error).toBeInstanceOf(TimeoutError)
      expect(error.operation).toBe('cwSpeed')
    })

    it('timeout advances to next queued operation', async () => {
      const p1 = queue.enqueue('status').catch(() => {}) // suppress unhandled
      const p2 = queue.enqueue('cwSpeed').catch(() => {}) // suppress unhandled

      jest.advanceTimersByTime(12100)
      await Promise.resolve()
      await Promise.resolve()

      // p1 timed out, p2 should now be active
      expect(queue.activeType).toBe('cwSpeed')
    })
  })

  describe('sendCW', () => {
    it('flushes queue and suspends traffic before sending', () => {
      queue.enqueue('sendCW', 'CQ CQ').catch(() => {})
      expect(flushed).toBe(1)
      expect(suspended).toBe(1)
    })

    it('resumes traffic and completes after 800ms delay', async () => {
      const promise = queue.enqueue('sendCW', 'CQ')
      let resolved = false
      promise.then(() => { resolved = true })

      expect(resolved).toBe(false)
      jest.advanceTimersByTime(900)
      await Promise.resolve()

      expect(resumed).toBe(1)
      expect(resolved).toBe(true)
    })
  })

  describe('stopCW', () => {
    it('sends stop and resumes traffic after 100ms', async () => {
      const promise = queue.enqueue('stopCW')
      let resolved = false
      promise.then(() => { resolved = true })

      jest.advanceTimersByTime(200)
      await Promise.resolve()

      expect(resumed).toBe(1)
      expect(resolved).toBe(true)
    })
  })

  describe('setCWSpeed', () => {
    it('completes on ACK', async () => {
      const promise = queue.enqueue('setCWSpeed', 25)
      let resolved = false
      promise.then(() => { resolved = true })

      queue.handleResponse('ack', null)
      await Promise.resolve()

      expect(resolved).toBe(true)
    })

    it('rejects on NAK', async () => {
      const promise = queue.enqueue('setCWSpeed', 25)
      let error = null
      promise.catch(e => { error = e })

      queue.handleResponse('nak', null)
      await Promise.resolve()
      await Promise.resolve()

      expect(error).toBeInstanceOf(OperationCancelledError)
    })
  })

  describe('flushPending', () => {
    it('rejects all pending (not active) operations', async () => {
      queue.enqueue('status').catch(() => {})
      const p2 = queue.enqueue('cwSpeed')
      const p3 = queue.enqueue('cwSpeed')

      let errors = []
      p2.catch(e => errors.push(e))
      p3.catch(e => errors.push(e))

      queue.flushPending()
      await Promise.resolve()
      await Promise.resolve()

      expect(errors.length).toBe(2)
      expect(errors[0]).toBeInstanceOf(OperationCancelledError)
      expect(errors[1]).toBeInstanceOf(OperationCancelledError)
      // Active operation still running
      expect(queue.isActive).toBe(true)
    })
  })

  describe('cancelAll', () => {
    it('cancels active and pending operations', async () => {
      const p1 = queue.enqueue('status')
      const p2 = queue.enqueue('cwSpeed')

      let errors = []
      p1.catch(e => errors.push(e))
      p2.catch(e => errors.push(e))

      queue.cancelAll()
      await Promise.resolve()
      await Promise.resolve()

      expect(errors.length).toBe(2)
      expect(queue.isActive).toBe(false)
      expect(queue.depth).toBe(0)
    })
  })

  describe('unknown operation type', () => {
    it('rejects with error', async () => {
      let error = null
      await queue.enqueue('bogus').catch(e => { error = e })
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toContain('Unknown operation')
    })
  })
})
