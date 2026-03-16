import { SessionState, State } from '../protocol/SessionState'

describe('SessionState', () => {
  let ss

  beforeEach(() => {
    ss = new SessionState()
  })

  describe('initial state', () => {
    it('starts disconnected', () => {
      expect(ss.current).toBe(State.disconnected)
    })

    it('isConnected is false when disconnected', () => {
      expect(ss.isConnected).toBe(false)
    })

    it('isBusy is false when disconnected', () => {
      expect(ss.isBusy).toBe(false)
    })

    it('radioName is empty initially', () => {
      expect(ss.radioName).toBe('')
    })
  })

  describe('transitions', () => {
    it('can transition disconnected -> connecting', () => {
      expect(ss.canTransition(State.connecting)).toBe(true)
      expect(ss.transition(State.connecting)).toBe(true)
      expect(ss.current).toBe(State.connecting)
    })

    it('cannot transition disconnected -> connected directly', () => {
      expect(ss.canTransition(State.connected)).toBe(false)
      expect(ss.transition(State.connected)).toBe(false)
      expect(ss.current).toBe(State.disconnected)
    })

    it('connecting -> connected', () => {
      ss.transition(State.connecting)
      expect(ss.transition(State.connected, 'IC-705')).toBe(true)
      expect(ss.current).toBe(State.connected)
      expect(ss.radioName).toBe('IC-705')
    })

    it('connecting -> disconnected (timeout/failure)', () => {
      ss.transition(State.connecting)
      expect(ss.transition(State.disconnected)).toBe(true)
      expect(ss.current).toBe(State.disconnected)
    })

    it('connected -> queryingStatus', () => {
      ss.transition(State.connecting)
      ss.transition(State.connected)
      expect(ss.transition(State.queryingStatus)).toBe(true)
      expect(ss.current).toBe(State.queryingStatus)
    })

    it('connected -> sendingCW', () => {
      ss.transition(State.connecting)
      ss.transition(State.connected)
      expect(ss.transition(State.sendingCW)).toBe(true)
      expect(ss.current).toBe(State.sendingCW)
    })

    it('queryingStatus -> sendingCW (CW preempts status polling)', () => {
      ss.transition(State.connecting)
      ss.transition(State.connected)
      ss.transition(State.queryingStatus)
      expect(ss.canTransition(State.sendingCW)).toBe(true)
      expect(ss.transition(State.sendingCW)).toBe(true)
      expect(ss.current).toBe(State.sendingCW)
    })

    it('sendingCW -> connected (CW complete)', () => {
      ss.transition(State.connecting)
      ss.transition(State.connected)
      ss.transition(State.sendingCW)
      expect(ss.transition(State.connected)).toBe(true)
      expect(ss.current).toBe(State.connected)
    })

    it('connected -> disconnecting -> disconnected', () => {
      ss.transition(State.connecting)
      ss.transition(State.connected)
      expect(ss.transition(State.disconnecting)).toBe(true)
      expect(ss.transition(State.disconnected)).toBe(true)
    })

    it('cannot transition sendingCW -> queryingStatus', () => {
      ss.transition(State.connecting)
      ss.transition(State.connected)
      ss.transition(State.sendingCW)
      expect(ss.canTransition(State.queryingStatus)).toBe(false)
    })
  })

  describe('computed properties', () => {
    it('isConnected is true for connected, queryingStatus, sendingCW', () => {
      ss.transition(State.connecting)
      expect(ss.isConnected).toBe(false)

      ss.transition(State.connected)
      expect(ss.isConnected).toBe(true)

      ss.transition(State.queryingStatus)
      expect(ss.isConnected).toBe(true)

      ss.transition(State.connected)
      ss.transition(State.sendingCW)
      expect(ss.isConnected).toBe(true)
    })

    it('isBusy is true for connecting, queryingStatus, sendingCW, disconnecting', () => {
      ss.transition(State.connecting)
      expect(ss.isBusy).toBe(true)

      ss.transition(State.connected)
      expect(ss.isBusy).toBe(false)

      ss.transition(State.queryingStatus)
      expect(ss.isBusy).toBe(true)

      ss.transition(State.connected)
      ss.transition(State.disconnecting)
      expect(ss.isBusy).toBe(true)
    })
  })

  describe('events', () => {
    it('emits stateChanged on transition', () => {
      const events = []
      ss.on('stateChanged', (info) => events.push(info))

      ss.transition(State.connecting)
      expect(events.length).toBe(1)
      expect(events[0].state).toBe(State.connecting)
      expect(events[0].from).toBe(State.disconnected)
    })

    it('does not emit on failed transition', () => {
      const events = []
      ss.on('stateChanged', (info) => events.push(info))

      ss.transition(State.connected) // invalid from disconnected
      expect(events.length).toBe(0)
    })

    it('includes radioName in state change event', () => {
      const events = []
      ss.on('stateChanged', (info) => events.push(info))

      ss.transition(State.connecting)
      ss.transition(State.connected, 'IC-705')
      expect(events[1].radioName).toBe('IC-705')
    })

    it('clears radioName on disconnect', () => {
      ss.transition(State.connecting)
      ss.transition(State.connected, 'IC-705')
      expect(ss.radioName).toBe('IC-705')

      ss.transition(State.disconnecting)
      ss.transition(State.disconnected)
      expect(ss.radioName).toBe('')
    })
  })

  describe('reset', () => {
    it('resets to disconnected', () => {
      ss.transition(State.connecting)
      ss.transition(State.connected, 'IC-705')
      ss.reset()
      expect(ss.current).toBe(State.disconnected)
      expect(ss.radioName).toBe('')
    })
  })
})
