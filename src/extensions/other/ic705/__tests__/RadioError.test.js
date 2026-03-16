import {
  RadioError,
  NotConnectedError,
  AlreadyConnectingError,
  TimeoutError,
  AuthenticationFailedError,
  RadioBusyError,
  NetworkError,
  InvalidResponseError,
  OperationCancelledError,
  OperationInProgressError,
  InvalidStateError
} from '../protocol/RadioError'

describe('RadioError', () => {
  it('all errors extend RadioError and Error', () => {
    const errors = [
      new NotConnectedError(),
      new AlreadyConnectingError(),
      new TimeoutError('status', 12000),
      new AuthenticationFailedError(),
      new RadioBusyError(),
      new NetworkError(new Error('socket closed')),
      new InvalidResponseError(),
      new OperationCancelledError(),
      new OperationInProgressError('sendCW'),
      new InvalidStateError('unexpected disconnected')
    ]

    for (const err of errors) {
      expect(err).toBeInstanceOf(RadioError)
      expect(err).toBeInstanceOf(Error)
      expect(typeof err.message).toBe('string')
      expect(err.message.length).toBeGreaterThan(0)
    }
  })

  it('instanceof checks distinguish error types', () => {
    const timeout = new TimeoutError('status', 12000)
    expect(timeout).toBeInstanceOf(TimeoutError)
    expect(timeout).not.toBeInstanceOf(NotConnectedError)

    const notConn = new NotConnectedError()
    expect(notConn).toBeInstanceOf(NotConnectedError)
    expect(notConn).not.toBeInstanceOf(TimeoutError)
  })

  it('TimeoutError carries operation and duration', () => {
    const err = new TimeoutError('cwSpeed', 10000)
    expect(err.operation).toBe('cwSpeed')
    expect(err.duration).toBe(10000)
    expect(err.message).toContain('cwSpeed')
    expect(err.message).toContain('10000')
  })

  it('NetworkError wraps cause', () => {
    const cause = new Error('ECONNREFUSED')
    const err = new NetworkError(cause)
    expect(err.cause).toBe(cause)
    expect(err.message).toContain('ECONNREFUSED')
  })

  it('OperationInProgressError carries operation name', () => {
    const err = new OperationInProgressError('sendCW')
    expect(err.operationName).toBe('sendCW')
    expect(err.message).toContain('sendCW')
  })

  it('InvalidStateError carries details', () => {
    const err = new InvalidStateError('cannot send while disconnected')
    expect(err.details).toBe('cannot send while disconnected')
    expect(err.message).toContain('cannot send while disconnected')
  })

  it('error names are set correctly', () => {
    expect(new NotConnectedError().name).toBe('NotConnectedError')
    expect(new AlreadyConnectingError().name).toBe('AlreadyConnectingError')
    expect(new TimeoutError('x', 1).name).toBe('TimeoutError')
    expect(new AuthenticationFailedError().name).toBe('AuthenticationFailedError')
    expect(new RadioBusyError().name).toBe('RadioBusyError')
    expect(new NetworkError().name).toBe('NetworkError')
    expect(new InvalidResponseError().name).toBe('InvalidResponseError')
    expect(new OperationCancelledError().name).toBe('OperationCancelledError')
    expect(new OperationInProgressError('x').name).toBe('OperationInProgressError')
    expect(new InvalidStateError('x').name).toBe('InvalidStateError')
  })
})
