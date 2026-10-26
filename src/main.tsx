import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installErrorReport } from './utils/analytics'

// 全局 JS 错误轻量上报（只取错误类型名，不含内容）——错误分布给「错误人话化」排序用
installErrorReport()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
