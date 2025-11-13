import React from 'react'
import ReactDOM from 'react-dom'

import App from './App'

import './index.css'

import * as _console from './utils/console'
_console.init()

ReactDOM.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
  document.getElementById('root')
)
