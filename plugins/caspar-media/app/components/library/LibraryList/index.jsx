import React from 'react'
import './style.css'

import { LibraryListItem } from '../LibraryListItem'

export const LibraryList = ({ items = [], onLibraryRefresh = () => {} }) => {
  return (
    <ul className='LibraryList'>
      {
        (items || []).map((item, i) => {
          return (
            <LibraryListItem
              key={`${item?.name || ''}-${i}`}
              item={item}
              onLibraryRefresh={onLibraryRefresh}
            />
          )
        })
      }
    </ul>
  )
}
