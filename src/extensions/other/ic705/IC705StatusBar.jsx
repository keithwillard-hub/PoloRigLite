/*
 * IC-705 Status Bar — compact radio status display for the logging panel.
 *
 * Shows: connection indicator, frequency, mode, CW speed, sending indicator,
 * and operation state (e.g., "querying..." during status polls).
 * Only renders when IC-705 native module is available.
 */

import React, { useEffect } from 'react'
import { View } from 'react-native'
import { Text } from 'react-native-paper'
import { useDispatch } from 'react-redux'

import { useThemedStyles } from '../../../styles/tools/useThemedStyles'
import { useIC705 } from '../../../hooks/useIC705'
import { setVFO } from '../../../store/station/stationSlice'
import { bandForFrequency, modeForFrequency } from '@ham2k/lib-operation-data'

const OPERATION_LABELS = {
  status: 'querying...',
  cwSpeedWarmup: 'querying...',
  cwSpeed: 'querying speed...',
  sendCW: 'sending...',
  setCWSpeed: 'setting speed...',
  stopCW: 'stopping...'
}

function prepareStyles (baseStyles) {
  return {
    ...baseStyles,
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: baseStyles.oneSpace,
      paddingVertical: baseStyles.halfSpace / 2,
      gap: baseStyles.oneSpace
    },
    dot: {
      width: 8,
      height: 8,
      borderRadius: 4
    },
    freqText: {
      fontFamily: 'Roboto Mono',
      fontSize: baseStyles.normalFontSize * 0.85,
      fontWeight: '600'
    },
    modeText: {
      fontSize: baseStyles.normalFontSize * 0.8,
      fontWeight: '500'
    },
    speedText: {
      fontSize: baseStyles.normalFontSize * 0.75,
      opacity: 0.7
    },
    sendingText: {
      fontSize: baseStyles.normalFontSize * 0.75,
      fontWeight: '700'
    },
    opText: {
      fontSize: baseStyles.normalFontSize * 0.7,
      fontStyle: 'italic',
      opacity: 0.6
    }
  }
}

export default function IC705StatusBar () {
  const styles = useThemedStyles(prepareStyles)
  const { isConnected, frequency, frequencyDisplay, mode, cwSpeed, isSending, isAvailable, isBusy, activeOperation } = useIC705()
  const dispatch = useDispatch()

  // Sync radio frequency/mode to Redux VFO so QSO form stays in sync
  useEffect(() => {
    if (isConnected && frequency > 0) {
      dispatch(setVFO({
        freq: frequency,
        band: bandForFrequency(frequency),
        mode: mode || modeForFrequency(frequency)
      }))
    }
  }, [isConnected, frequency, mode, dispatch])

  if (!isAvailable) return null
  if (!isConnected) return null

  const opLabel = activeOperation ? OPERATION_LABELS[activeOperation] : null

  return (
    <View style={styles.container}>
      {/* Connection indicator */}
      <View style={[
        styles.dot,
        { backgroundColor: isConnected ? '#4CAF50' : '#9E9E9E' }
      ]} />

      {/* Frequency */}
      <Text style={[styles.freqText, { color: styles.theme.colors.onSurface }]}>
        {frequencyDisplay || '---'}
      </Text>

      {/* Mode */}
      {mode && (
        <Text style={[styles.modeText, { color: styles.theme.colors.primary }]}>
          {mode}
        </Text>
      )}

      {/* CW Speed */}
      {cwSpeed > 0 && (
        <Text style={[styles.speedText, { color: styles.theme.colors.onSurfaceVariant }]}>
          {cwSpeed}wpm
        </Text>
      )}

      {/* Sending indicator */}
      {isSending && (
        <Text style={[styles.sendingText, { color: '#FF9800' }]}>
          TX
        </Text>
      )}

      {/* Operation state */}
      {opLabel && !isSending && (
        <Text style={[styles.opText, { color: styles.theme.colors.onSurfaceVariant }]}>
          {opLabel}
        </Text>
      )}
    </View>
  )
}
