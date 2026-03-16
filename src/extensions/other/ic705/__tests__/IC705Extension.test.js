/*
 * Tests for IC705Extension callCommit hook behavior.
 */

// Mock IC705RigControl before importing the extension
const mockGetStatus = jest.fn()
const mockSendTemplatedCW = jest.fn()

jest.mock('../IC705RigControl', () => ({
  IC705: {
    isAvailable: true,
    getStatus: (...args) => mockGetStatus(...args),
    sendTemplatedCW: (...args) => mockSendTemplatedCW(...args)
  }
}))

// Import after mock setup
const { resetCWSentCalls } = require('../IC705Extension')
const Extension = require('../IC705Extension').default

describe('IC705Extension CWCallCommitHook', () => {
  let hook

  beforeEach(() => {
    // Extract the callCommit hook from onActivation
    const hooks = {}
    Extension.onActivation({
      registerHook: (type, { hook: h }) => {
        hooks[type] = hooks[type] || []
        hooks[type].push(h)
      }
    })
    hook = hooks.callCommit[0]

    // Reset mocks and sent-calls set
    mockGetStatus.mockReset()
    mockSendTemplatedCW.mockReset()
    mockGetStatus.mockResolvedValue({ isConnected: true })
    mockSendTemplatedCW.mockResolvedValue(undefined)
    resetCWSentCalls()
  })

  const baseSettings = {
    ic705: { autoSendCWOnMiss: true, cwTemplate: '$callsign?' },
    operatorCall: 'AC0VW'
  }

  it('sends CW on callCommit when no name found', async () => {
    await hook.onCallCommit({
      call: 'W1AW',
      lookupStatus: { guess: {} },
      settings: baseSettings
    })

    expect(mockSendTemplatedCW).toHaveBeenCalledWith(
      '$callsign?',
      { callsign: 'W1AW', mycall: 'AC0VW' },
      baseSettings
    )
  })

  it('does NOT send CW again for same callsign (dedup Set)', async () => {
    await hook.onCallCommit({
      call: 'W1AW',
      lookupStatus: { guess: {} },
      settings: baseSettings
    })
    expect(mockSendTemplatedCW).toHaveBeenCalledTimes(1)

    // Same call again
    await hook.onCallCommit({
      call: 'W1AW',
      lookupStatus: { guess: {} },
      settings: baseSettings
    })
    expect(mockSendTemplatedCW).toHaveBeenCalledTimes(1) // still 1
  })

  it('clears Set via resetCWSentCalls (new QSO)', async () => {
    // Send first time
    await hook.onCallCommit({
      call: 'W1AW',
      lookupStatus: { guess: {} },
      settings: baseSettings
    })
    expect(mockSendTemplatedCW).toHaveBeenCalledTimes(1)

    // resetCWSentCalls clears the dedup set (called externally on new QSO)
    resetCWSentCalls()

    // Now the same call should send again
    await hook.onCallCommit({
      call: 'W1AW',
      lookupStatus: { guess: {} },
      settings: baseSettings
    })
    expect(mockSendTemplatedCW).toHaveBeenCalledTimes(2)
  })

  it('does NOT send CW when lookupStatus has a name', async () => {
    await hook.onCallCommit({
      call: 'W1AW',
      lookupStatus: { guess: { name: 'ARRL' } },
      settings: baseSettings
    })

    expect(mockSendTemplatedCW).not.toHaveBeenCalled()
  })

  it('does NOT send CW when autoSendCWOnMiss is disabled', async () => {
    await hook.onCallCommit({
      call: 'W1AW',
      lookupStatus: { guess: {} },
      settings: { ...baseSettings, ic705: { ...baseSettings.ic705, autoSendCWOnMiss: false } }
    })

    expect(mockSendTemplatedCW).not.toHaveBeenCalled()
  })

  it('removes call from Set on failed CW send (allows retry)', async () => {
    mockSendTemplatedCW.mockRejectedValueOnce(new Error('Send failed'))

    await hook.onCallCommit({
      call: 'W1AW',
      lookupStatus: { guess: {} },
      settings: baseSettings
    })
    expect(mockSendTemplatedCW).toHaveBeenCalledTimes(1)

    // Retry should work since the failed call was removed from the set
    mockSendTemplatedCW.mockResolvedValueOnce(undefined)
    await hook.onCallCommit({
      call: 'W1AW',
      lookupStatus: { guess: {} },
      settings: baseSettings
    })
    expect(mockSendTemplatedCW).toHaveBeenCalledTimes(2)
  })
})
