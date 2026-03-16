/*
 * Morse audio sidetone generator using react-native-audio-api.
 * Uses OscillatorNode + GainNode for sine wave tones with fade envelope.
 *
 * This module can be deferred to a later phase if the audio dependency is problematic.
 * Ported from CWSidetone.swift.
 */

const MORSE_TABLE = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.',
  G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..',
  M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.',
  S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
  Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-',
  5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
  '/': '-..-.', '?': '..--..', '.': '.-.-.-', ',': '--..--', '=': '-...-',
  '-': '-....-', '(': '-.--.', ')': '-.--.-', "'": '.----.', ':': '---...',
  '+': '.-.-.', '"': '.-..-.', '@': '.--.-.'
}

export class CWSidetone {
  constructor () {
    this.isEnabled = true
    this.pitchHz = 600
    this.volume = 0.8
    this.isPlaying = false
    this._stopRequested = false
  }

  /**
   * Play sidetone for a text string at the given WPM.
   * Uses Web Audio API style scheduling (available via react-native-audio-api).
   */
  async playText (text, wpm) {
    if (!this.isEnabled) return

    let AudioContext
    try {
      // Try react-native-audio-api
      const audioApi = require('react-native-audio-api')
      AudioContext = audioApi.AudioContext
    } catch {
      // Audio API not available — skip sidetone
      return
    }

    this._stopRequested = false
    this.isPlaying = true

    const ctx = new AudioContext()
    const ditMs = 1200.0 / wpm

    try {
      for (let i = 0; i < text.length; i++) {
        if (this._stopRequested) break

        const char = text[i].toUpperCase()

        if (char === ' ') {
          await this._sleep(ditMs * 4)
          continue
        }

        const pattern = MORSE_TABLE[char]
        if (!pattern) continue

        for (let j = 0; j < pattern.length; j++) {
          if (this._stopRequested) break

          const isDah = pattern[j] === '-'
          const durationMs = isDah ? ditMs * 3 : ditMs

          await this._playTone(ctx, durationMs)

          // Inter-element gap
          if (j < pattern.length - 1) {
            await this._sleep(ditMs)
          }
        }

        // Inter-character gap
        if (!this._stopRequested && i < text.length - 1 && text[i + 1] !== ' ') {
          await this._sleep(ditMs * 3)
        }
      }
    } finally {
      ctx.close?.()
      this.isPlaying = false
    }
  }

  stop () {
    this._stopRequested = true
  }

  async _playTone (ctx, durationMs) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.frequency.value = this.pitchHz
    osc.type = 'sine'

    const now = ctx.currentTime
    const duration = durationMs / 1000
    const fadeTime = 0.005 // 5ms fade

    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(this.volume, now + fadeTime)
    gain.gain.setValueAtTime(this.volume, now + duration - fadeTime)
    gain.gain.linearRampToValueAtTime(0, now + duration)

    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + duration)

    await this._sleep(durationMs)
  }

  _sleep (ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
