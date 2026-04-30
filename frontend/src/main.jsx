import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { ToastProvider } from './components/Toast'
import { migrateLegacyStorageKeys } from './lib/storage'
import './index.css'

// One-time rename migration: copies fintrack.*/fintrack-* localStorage
// keys onto tuskledger.*/tuskledger-* equivalents so user UI state
// survives the project rename. Idempotent; runs before any feature
// component reads its keys. Safe to leave in place forever — once the
// sentinel is set, subsequent calls no-op.
migrateLegacyStorageKeys()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <App />
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>
)
