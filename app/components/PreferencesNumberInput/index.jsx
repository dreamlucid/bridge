import React from 'react'
import './style.css'

import * as random from '../../utils/random'

export function PreferencesNumberInput ({ label, value = '', min = 0, max = 10, onChange = () => {} }) {
  const [id] = React.useState(`number-${random.number()}`)
  const [localValue, setLocalValue] = React.useState(value)
  const [error, setError] = React.useState()

  // Update local value when prop value changes (e.g., from external state updates)
  React.useEffect(() => {
    setLocalValue(value)
  }, [value])

  React.useEffect(() => {
    const numValue = Number(localValue)
    if (isNaN(numValue)) {
      setError(undefined)
      return
    }

    if (numValue < min) {
      setError(`Cannot be less than ${min}`)
      return
    }

    if (numValue > max) {
      setError(`Cannot be more than ${max}`)
      return
    }

    setError(undefined)
  }, [localValue, min, max])

  const handleChange = (e) => {
    const newValue = e.target.value
    setLocalValue(newValue) // Update UI immediately
    onChange(newValue) // Trigger debounced state update
  }

  return (
    <div className='PreferencesNumberInput'>
      <input id={id} className='PreferencesNumberInput-input' type='number' min={min} max={max} value={localValue} onChange={handleChange} />
      <label htmlFor={id}>{label}</label>
      {
        error &&
        <div className='PreferencesNumberInput-error'>{error}</div>
      }
    </div>
  )
}
