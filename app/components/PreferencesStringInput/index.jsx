import React from 'react'
import './style.css'

import * as random from '../../utils/random'

export function PreferencesStringInput ({ label, value = '', onChange = () => {} }) {
  const [id] = React.useState(`number-${random.number()}`)
  const [localValue, setLocalValue] = React.useState(value)

  // Update local value when prop value changes (e.g., from external state updates)
  React.useEffect(() => {
    setLocalValue(value)
  }, [value])

  const handleChange = (e) => {
    const newValue = e.target.value
    setLocalValue(newValue) // Update UI immediately
    onChange(newValue) // Trigger debounced state update
  }

  return (
    <div className='PreferencesStringInput'>
      <label htmlFor={id}>{label}</label>
      <input id={id} className='PreferencesStringInput-input' type='text' value={localValue} placeholder={label} onChange={handleChange} />
    </div>
  )
}
