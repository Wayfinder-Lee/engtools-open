import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'http'

/**
 * 动态 API 代理插件
 *
 * 解决问题：浏览器从 localhost 直接请求外部 API 会触发 CORS 限制，
 * 导致 "Failed to fetch" 错误。此插件在 Vite 开发服务器中注入一个
 * 中间件，将 /api/proxy 的请求转发到实际的 LLM API 端点。
 *
 * 使用方式：
 * - 前端发请求到 /api/proxy（同源，无 CORS 问题）
 * - 在 X-Proxy-Target 头中指定真正的 API 端点
 * - 中间件将请求体和认证头原样转发
 */
function apiProxyPlugin() {
  return {
    name: 'api-proxy',
    configureServer(server: any) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        // 只拦截 /api/proxy 请求
        if (!req.url?.startsWith('/api/proxy')) {
          return next()
        }

        // 只处理 POST
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Proxy-Target',
          })
          res.end()
          return
        }

        const targetUrl = req.headers['x-proxy-target'] as string
        if (!targetUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: '缺少 X-Proxy-Target 请求头，无法确定代理目标' }))
          return
        }

        // 收集请求体
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', async () => {
          const body = Buffer.concat(chunks).toString()

          try {
            const fetchResponse = await fetch(targetUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: req.headers['authorization'] || '',
              },
              body: body || undefined,
            })

            const responseBody = await fetchResponse.text()

            res.writeHead(fetchResponse.status, {
              'Content-Type': fetchResponse.headers.get('content-type') || 'application/json',
              'Access-Control-Allow-Origin': '*',
            })
            res.end(responseBody)
          } catch (e: any) {
            console.error('[api-proxy] 代理请求失败:', e.message)
            res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({
              error: `代理请求失败: ${e.message}`,
              hint: '请检查 API 端点地址是否正确，以及网络是否可达',
            }))
          }
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), apiProxyPlugin()],
  build: {
    rollupOptions: {
      input: {
        // 主站产物命名保持原样（assets/index-<hash>.js）
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        // 扫码拍照上传（手机端第二入口）；token 在 query 不在文件名，
        // 产物按 chunk 名落 assets/mu-[hash].js
        mu: fileURLToPath(new URL('./m-upload.html', import.meta.url)),
      },
    },
  },
})
