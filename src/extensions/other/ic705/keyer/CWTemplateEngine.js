/*
 * Pure, stateless template interpolation engine for $variable_name syntax.
 * Processes $variable placeholders before the {MACRO} system.
 */

function isVariableStart (c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'
}

function isVariableContinuation (c) {
  return isVariableStart(c) || (c >= '0' && c <= '9')
}

/**
 * Interpolate $variable_name placeholders from a dictionary.
 * Unknown variables are replaced with empty string.
 * All values are uppercased for CW transmission.
 */
export function interpolate (template, variables) {
  if (!template) return ''

  let result = ''
  let i = 0

  while (i < template.length) {
    if (template[i] === '$') {
      const afterDollar = i + 1
      if (afterDollar < template.length && isVariableStart(template[afterDollar])) {
        let nameEnd = afterDollar + 1
        while (nameEnd < template.length && isVariableContinuation(template[nameEnd])) {
          nameEnd++
        }
        const name = template.slice(afterDollar, nameEnd)
        const value = variables[name] ?? ''
        result += value.toUpperCase()
        i = nameEnd
      } else {
        result += '$'
        i = afterDollar
      }
    } else {
      result += template[i]
      i++
    }
  }

  return result
}

/**
 * Build a standard variable dictionary from current app state.
 */
export function standardVariables (callsign, myCallsign, frequencyHz, mode, name) {
  const vars = {
    callsign: callsign || '',
    mycall: myCallsign || '',
    rst: defaultRSTForMode(mode),
    freq: formatKHz(frequencyHz)
  }
  if (name) vars.name = name
  return vars
}

function defaultRSTForMode (mode) {
  if (!mode) return '599'
  switch (mode) {
    case 'CW': case 'CW-R': return '599'
    case 'LSB': case 'USB': return '59'
    case 'AM': case 'FM': return '59'
    case 'RTTY': case 'RTTY-R': return '599'
    default: return '599'
  }
}

function formatKHz (hz) {
  if (!hz || hz <= 0) return '0'
  return String(Math.floor(hz / 1000))
}
