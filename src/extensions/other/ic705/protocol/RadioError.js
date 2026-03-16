/*
 * Structured error types for IC-705 radio operations.
 * Ported from RadioError.swift.
 */

export class RadioError extends Error {
  constructor (message) {
    super(message)
    this.name = 'RadioError'
  }
}

export class NotConnectedError extends RadioError {
  constructor () {
    super('Not connected to radio')
    this.name = 'NotConnectedError'
  }
}

export class AlreadyConnectingError extends RadioError {
  constructor () {
    super('Already connecting to radio')
    this.name = 'AlreadyConnectingError'
  }
}

export class TimeoutError extends RadioError {
  constructor (operation, duration) {
    super(`Operation '${operation}' timed out after ${duration}ms`)
    this.name = 'TimeoutError'
    this.operation = operation
    this.duration = duration
  }
}

export class AuthenticationFailedError extends RadioError {
  constructor () {
    super('Authentication failed')
    this.name = 'AuthenticationFailedError'
  }
}

export class RadioBusyError extends RadioError {
  constructor () {
    super('Radio is busy')
    this.name = 'RadioBusyError'
  }
}

export class NetworkError extends RadioError {
  constructor (cause) {
    super(cause?.message || 'Network error')
    this.name = 'NetworkError'
    this.cause = cause
  }
}

export class InvalidResponseError extends RadioError {
  constructor () {
    super('Invalid response from radio')
    this.name = 'InvalidResponseError'
  }
}

export class OperationCancelledError extends RadioError {
  constructor () {
    super('Operation was cancelled')
    this.name = 'OperationCancelledError'
  }
}

export class OperationInProgressError extends RadioError {
  constructor (operationName) {
    super(`Operation '${operationName}' is already in progress`)
    this.name = 'OperationInProgressError'
    this.operationName = operationName
  }
}

export class InvalidStateError extends RadioError {
  constructor (details) {
    super(`Invalid state: ${details}`)
    this.name = 'InvalidStateError'
    this.details = details
  }
}
