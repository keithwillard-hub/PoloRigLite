/*
 * Debug screen for IC-705 frequency tracking
 */

import React, { useEffect, useState } from 'react'
import { View, ScrollView } from 'react-native'
import { Text, Button } from 'react-native-paper'
import { useThemedStyles } from '../../../styles/tools/useThemedStyles'
import { IC705 } from './IC705RigControl'

function prepareStyles (baseStyles) {
  return {
    container: {
      flex: 1,
      padding: baseStyles.oneSpace
    },
    logEntry: {
      fontFamily: 'Roboto Mono',
      fontSize: baseStyles.smallFontSize,
      paddingVertical: 2
    }
  }
}

export default function IC705DebugScreen () {
  const styles = useThemedStyles(prepareStyles)
  const [logs, setLogs] = useState([])
  const [frequency, setFrequency] = useState(0)
  const [frequencyDisplay, setFrequencyDisplay] = useState('')
  const [mode, setMode] = useState(null)
  const [isConnected, setIsConnected] = useState(false)

  const addLog = (msg) => {
    setLogs(prev => [`${new Date().toLocaleTimeString()}: ${msg}`, ...prev].slice(0, 50))
  }

  useEffect(() => {
    addLog('Mounting - setting up subscriptions')

    // Get initial status
    IC705.getStatus().then(status => {
      addLog(`Initial status: ${JSON.stringify(status)}`)
      setIsConnected(status?.isConnected || false)
      setFrequency(status?.frequencyHz || 0)
      setFrequencyDisplay(status?.frequencyDisplay || '')
      setMode(status?.mode || null)
    }).catch(e => addLog(`Status error: ${e.message}`))

    // Subscribe to events
    const unsubs = [
      IC705.onConnectionStateChanged(state => {
        addLog(`Connection: ${state}`)
        setIsConnected(state === 'connected')
      }),
      IC705.onFrequencyChanged(e => {
        addLog(`Freq changed: ${JSON.stringify(e)}`)
        setFrequency(e.frequencyHz)
        setFrequencyDisplay(e.display)
      }),
      IC705.onModeChanged(e => {
        addLog(`Mode changed: ${JSON.stringify(e)}`)
        setMode(e.mode)
      })
    ]

    return () => {
      addLog('Unmounting - cleaning up')
      unsubs.forEach(fn => typeof fn === 'function' && fn())
    }
  }, [])

  const handleQueryStatus = () => {
    addLog('Querying status...')
    IC705.queryStatus().then(result => {
      addLog(`Status result: ${JSON.stringify(result)}`)
    }).catch(e => addLog(`Query error: ${e.message}`))
  }

  return (
    <View style={styles.container}>
      <Text style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 10 }}>
        IC-705 Debug
      </Text>

      <Text>Connected: {isConnected ? 'YES' : 'NO'}</Text>
      <Text>Frequency: {frequency} Hz</Text>
      <Text>Display: {frequencyDisplay}</Text>
      <Text>Mode: {mode || '---'}</Text>

      <Button mode="contained" onPress={handleQueryStatus} style={{ marginVertical: 10 }}>
        Query Status
      </Button>

      <Text style={{ fontWeight: 'bold', marginTop: 10 }}>Event Logs:</Text>
      <ScrollView style={{ flex: 1, backgroundColor: '#f0f0f0', padding: 5 }}>
        {logs.map((log, i) => (
          <Text key={i} style={styles.logEntry}>{log}</Text>
        ))}
      </ScrollView>
    </View>
  )
}
