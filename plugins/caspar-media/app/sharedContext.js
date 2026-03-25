/**
 * @copyright Copyright © 2021 SVT Design
 * @author Axel Boberg <axel.boberg@svt.se>
 */

import React from 'react'
import bridge from 'bridge'

export const SharedContext = React.createContext()

export const Provider = ({ children }) => {
  const [state, setState] = React.useState()

  React.useEffect(() => {
    async function initState () {
      const state = await bridge.state.get()
      setState(state)
    }
    initState()
  }, [])

  React.useEffect(() => {
    function onStateChange (state) {
      setState({ ...state })
    }
    bridge.events.on('state.change', onStateChange)
    return () => bridge.events.off('state.change', onStateChange)
  }, [])

  return (
    <SharedContext.Provider value={[state]}>
      {children}
    </SharedContext.Provider>
  )
}
