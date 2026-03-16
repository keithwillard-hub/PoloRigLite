import { interpolate, standardVariables } from '../keyer/CWTemplateEngine'

describe('CWTemplateEngine', () => {
  describe('interpolate', () => {
    it('substitutes known variables', () => {
      const result = interpolate('$callsign DE $mycall K', {
        callsign: 'W1AW',
        mycall: 'AC0VW'
      })
      expect(result).toBe('W1AW DE AC0VW K')
    })

    it('uppercases values', () => {
      const result = interpolate('$callsign', { callsign: 'w1aw' })
      expect(result).toBe('W1AW')
    })

    it('replaces unknown variables with empty string', () => {
      const result = interpolate('$callsign $unknown', { callsign: 'W1AW' })
      expect(result).toBe('W1AW ')
    })

    it('preserves literal $ at end of string', () => {
      expect(interpolate('cost$', {})).toBe('cost$')
    })

    it('preserves $ followed by non-variable char', () => {
      expect(interpolate('$123', {})).toBe('$123')
    })

    it('handles empty template', () => {
      expect(interpolate('', { callsign: 'W1AW' })).toBe('')
    })

    it('handles null/undefined template', () => {
      expect(interpolate(null, {})).toBe('')
      expect(interpolate(undefined, {})).toBe('')
    })

    it('handles underscores in variable names', () => {
      const result = interpolate('$my_call', { my_call: 'AC0VW' })
      expect(result).toBe('AC0VW')
    })

    it('handles adjacent variables', () => {
      const result = interpolate('$a$b', { a: 'X', b: 'Y' })
      expect(result).toBe('XY')
    })

    it('preserves {MACRO} syntax untouched', () => {
      const result = interpolate('{SERIAL} $callsign', { callsign: 'W1AW' })
      expect(result).toBe('{SERIAL} W1AW')
    })
  })

  describe('standardVariables', () => {
    it('builds variables from state', () => {
      const vars = standardVariables('W1AW', 'AC0VW', 14060000, 'CW', 'John')
      expect(vars.callsign).toBe('W1AW')
      expect(vars.mycall).toBe('AC0VW')
      expect(vars.rst).toBe('599')
      expect(vars.freq).toBe('14060')
      expect(vars.name).toBe('John')
    })

    it('uses 59 RST for phone modes', () => {
      const vars = standardVariables('W1AW', 'AC0VW', 14200000, 'USB', null)
      expect(vars.rst).toBe('59')
      expect(vars.name).toBeUndefined()
    })

    it('defaults RST to 599 for unknown modes', () => {
      const vars = standardVariables('W1AW', 'AC0VW', 0, null, null)
      expect(vars.rst).toBe('599')
      expect(vars.freq).toBe('0')
    })
  })
})
