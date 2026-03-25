import React from 'react'
import './style.css'

import { SharedContext } from '../../../sharedContext'

/** @see plugins/caspar/lib/commands.js SERVER_GROUPS */
const SERVER_GROUPS = [
  {
    id: 'group:0',
    name: 'Group: Primary'
  },
  {
    id: 'group:1',
    name: 'Group: Secondary'
  }
]

const CASPAR_PLUGIN_NAME = 'bridge-plugin-caspar'

export const CasparServerSelector = ({ value = '__none', multipleValuesSelected = false, onChange = () => {} }) => {
  const [state] = React.useContext(SharedContext)
  const servers = state?.plugins?.[CASPAR_PLUGIN_NAME]?.servers || []

  return (
    <div className='ServerSelector'>
      <select className='Select--small' value={multipleValuesSelected ? '__multiple-values' : (value || '__none')} onChange={e => onChange(e.target.value)}>
        <option value='__none'>No server</option>
        {
          multipleValuesSelected &&
          <option value='__multiple-values' disabled>Multiple values</option>
        }
        {
          [...SERVER_GROUPS, ...servers].map(server => {
            return <option key={server.id} value={server?.id}>{server?.name || 'Unnamed'}</option>
          })
        }
      </select>
    </div>
  )
}
