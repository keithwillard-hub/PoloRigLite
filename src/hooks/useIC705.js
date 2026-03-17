/*
 * React hook for IC-705 rig control state.
 *
 * Subscribes to JS orchestrator events and provides current radio state.
 * Uses the JS-based protocol stack (not the native module wrapper).
 * Exposes Promise-based operation API and isBusy / activeOperation state.
 */

import { useState, useEffect, useCallback } from 'react'
import { AppState } from 'react-native'
import { IC705 } from '../extensions/other/ic705/IC705RigControl'

export function useIC705 () {
  const [connectionState, setConnectionState] = useState('disconnected')
  const [frequency, setFrequency] = useState(0)
  const [frequencyDisplay, setFrequencyDisplay] = useState('')
  const [mode, setMode] = useState(null)
  const [cwSpeed, setCWSpeed] = useState(0)
  const [isSending, setIsSending] = useState(false)
  const [radioName, setRadioName] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [activeOperation, setActiveOperation] = useState(null)

  useEffect(() => {
    if (!IC705.isAvailable) return

    console.log('[useIC705] Mounting - setting up subscriptions')

    // Sync current state from singleton on mount (handles navigate-away/back)
    IC705.getStatus().then(status => {
      console.log('[useIC705] Initial status:', status)
      if (status?.isConnected) {
        setConnectionState('connected')
        setFrequency(status.frequencyHz || 0)
        setFrequencyDisplay(status.frequencyDisplay || '')
        setMode(status.mode || null)
        setCWSpeed(status.cwSpeed || 0)
        setIsSending(status.isSending || false)
        setRadioName(status.radioName || '')
        setIsBusy(status.isBusy || false)
        setActiveOperation(status.activeOperation || null)
      }
    }).catch(() => {})

    const unsubs = [
      IC705.onConnectionStateChanged(state => {
        console.log('[useIC705] connectionStateChanged:', state)
        setConnectionState(state)
      }),
      IC705.onFrequencyChanged(e => {
        console.log('[useIC705] frequencyChanged:', e)
        setFrequency(e.frequencyHz)
        setFrequencyDisplay(e.display)
      }),
      IC705.onModeChanged(e => {
        console.log('[useIC705] modeChanged:', e)
        setMode(e.mode)
      }),
      IC705.onCWSpeedChanged(e => setCWSpeed(e.wpm)),
      IC705.onSendingStateChanged(e => setIsSending(e.isSending)),
      IC705.onRadioNameChanged(e => setRadioName(e.name)),
      IC705.onOperationStarted(e => {
        setIsBusy(true)
        setActiveOperation(e.type)
      }),
      IC705.onOperationCompleted(() => {
        setIsBusy(false)
        setActiveOperation(null)
      })
    ].filter(Boolean)

    return () => {
      console.log('[useIC705] Unmounting - cleaning up subscriptions')
      unsubs.forEach(fn => typeof fn === 'function' && fn())
    }
  }, [])

  // Refresh status when app becomes active (handles navigate-away/back)
  useEffect(() => {
    if (!IC705.isAvailable) return

    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') {
        IC705.getStatus().then(status => {
          if (status?.isConnected) {
            setConnectionState('connected')
            setFrequency(status.frequencyHz || 0)
            setFrequencyDisplay(status.frequencyDisplay || '')
            setMode(status.mode || null)
            setCWSpeed(status.cwSpeed || 0)
            setIsSending(status.isSending || false)
            setRadioName(status.radioName || '')
            setIsBusy(status.isBusy || false)
            setActiveOperation(status.activeOperation || null)
          }
        }).catch(() => {})
      }
    })

    return () => subscription.remove()
  }, [])

  const connect = useCallback((host, username, password) => {
    return IC705.connect(host, username, password)
  }, [])

  const disconnect = useCallback(() => {
    return IC705.disconnect()
  }, [])

  return {
    // State
    connectionState,
    isConnected: connectionState === 'connected',
    isConnecting: connectionState === 'connecting',
    frequency,
    frequencyDisplay,
    mode,
    cwSpeed,
    isSending,
    radioName,
    isBusy,
    activeOperation,

    // Actions
    connect,
    disconnect,
    queryStatus: () => IC705.queryStatus(),
    sendCW: (text) => IC705.sendCW(text),
    sendTemplatedCW: (template, vars) => IC705.sendTemplatedCW(template, vars),
    setCWSpeed: (wpm) => IC705.setCWSpeed(wpm),
    queryCWSpeed: () => IC705.queryCWSpeed(),
    cancelCW: () => IC705.cancelCW(),
    getStatus: () => IC705.getStatus(),

    // Availability
    isAvailable: IC705.isAvailable
  }
}
