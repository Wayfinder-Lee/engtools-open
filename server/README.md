# English Teacher Toolkit — 后端（engtools-api）

邮箱登录 + 额度计费 + LLM 转发。标准 **Node.js 20 HTTP 服务**（默认监听 9000），数据存 **Tablestore 宽表 NoSQL**。

前端所有 LLM 请求携带 JWT 打到本服务的 `/api/llm/chat`，服务端用**自己持有的中转站密钥**转发上游，并按操作扣额度（1–30 点/次，见下方计费表）。真实 LLM 密钥永不下发浏览器。

## 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/` | — | 健康检查 |
| POST | `/api/auth/send-verify-code` | — | `{email,purpose}` 发 6 位邮箱验证码（purpose=register/reset；60s 内不可重发） |
| POST | `/api/auth/register` | — | `{email,password,verifyCode}`（密码 ≥6 位）→ `{token,email,quota}` |
| POST | `/api/auth/reset-password` | — | `{email,password,verifyCode}` 重置密码 |
| POST | `/api/auth/login` | — | `{email,password}` → `{token,email,quota}` |
| GET | `/api/me` | Bearer | → `{email,quota}` |
| POST | `/api/redeem` | Bearer | `{code}` → `{credits,quota}` |
| POST | `/api/llm/chat` | Bearer | OpenAI 兼容 body（`_operation` 区分操作），按操作扣 1–30 额度，响应保持 `choices` 结构；上游失败自动退款；额度不足返回 402 |
| POST | `/api/unlock-word-limit` | Bearer | 扣 1 额度解锁当日自定义加词（每日前 50 次免费） |
| POST | `/api/tts` | Bearer | 听力语音合成（云端 TTS；登录用户，免费，日限流） |

计费表（`src/index.js` 的 `CREDIT_COST`）：ocr=1、vocab_section=5、copybook=5、exampaper=5、cloze=20、practical=20、continuation=30、worksheet=30、class_report=10、word=0（每日前 50 次免费）。修改后需重新部署。

## 扫码拍照上传（/api/m/*，src/mupload.js + mupload-db.js）

老师电脑端出二维码 → 自己的手机免登录拍照 → 照片实时出现在电脑端 → 走现有 OCR 流水。可整体摘除（删 mupload.js / mupload-db.js + index.js 挂载段 + init-tables 可选段，其余文件零改动）。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/m/tasks` | Bearer | `{label?,force?}` 建任务；已有进行中任务 409 `{unimportedCount}`，force 先建新后删旧 |
| GET | `/api/m/task?tid=&since=` | Bearer | 增量轮询（thumb 仅随 `seq>since` 行下发，单次 ≤12 张）；过期顺带惰性清理 |
| POST | `/api/m/token` | Bearer | 非破坏性续码（同 tokenSeq） |
| POST | `/api/m/photo-data` | Bearer | `{tid,photoId}` 取整图 dataURL |
| POST | `/api/m/photo-delete` | Bearer | 删行 + 计数减 |
| POST | `/api/m/photos-imported` | Bearer | `{tid,photoIds[]}` 识别成功打标（≤100/次） |
| POST | `/api/m/refresh` | Bearer | tokenSeq/sess +1（旧会话全失效）。API 兼容保留；前端不绑设备，无调用方 |
| POST | `/api/m/close` | Bearer | 完成并清理；有未识别照片 409，force 删 |
| POST | `/api/m/claim` | — | `{token,deviceId}` 扫码连接（**不绑设备**：任意设备可扫、多设备会话并存，deviceBound 仅记录）；限流只计伪造签名 ≤50/天/IP |
| POST | `/api/m/verify-session` | — | 断线恢复 / 对账 |
| POST | `/api/m/upload` | body.session | `{photoId,dataUrl,…}` 幂等上传（重传 `replaced:true`），≤99 张/任务、≤1.4M chars JPEG |

- **表**：`mupload_tasks` (ownerEmail+taskId)、`mupload_index` (taskId→owner，token 不含邮箱)、`mupload_photos` (taskId+photoId 元数据)、`mupload_chunks` (taskId+key 64KB 分块照片数据)。建表走 `npm run init-tables`（自动检测模块）。
- **照片分块**：托管数据库的大响应读会概率性停摆（SDK 无超时），照片按 64KB/行存独立表 + 读超时 15s 重试 1 次；删除路径**零扫描**——块 key `${photoId}#${两位序号}` 由 meta.chunkCount 直接构造 batchWriteRow DELETE；孤儿兜底才扫（`limit=1` 全列扫分页）。⚠️ GetRange 无「只取主键」模式，`columnsToGet:['__none__']` 伪列名静默返回 0 行（实测证伪，勿再用）。
- **Token/会话**：二维码 JWT `{tid,typ:'mupload',ts}` 15 分钟（不含邮箱——二维码是投影公开物）；会话 JWT `{tid,dev,typ:'msession',sv}` 24 小时放请求体，会话有效性只看 `sv===task.sess`。桌面静默续码（到期前 2min，同 tokenSeq），已连手机不受影响。
- **过期清理**：惰性门闩（任意 /api/m GET 触发，上海时区每小时一次）+ 平台定时触发器兜底（每小时；事件调用形态由 `index.js` 自动识别 = 显式 header ∨「非 /api 路径且事件体含 triggerName/triggerTime」，验证用 `node scripts/spike-timer-verify.js`）。


## 目录

```
server/
├── src/
│   ├── index.js        HTTP 服务 + 路由 + LLM 计费转发
│   ├── config.js       环境变量解析/校验（支持本地 .env）
│   ├── tablestore.js   数据层（用户、兑换码、原子扣/退额度）
│   ├── auth.js         bcrypt 密码 + JWT
│   ├── mail.js          nodemailer SMTP 验证码
│   ├── mupload.js + mupload-db.js   扫码拍照上传（可摘除）
│   ├── tts.js          听力 TTS（可摘除：未配置自动停用）
│   └── http.js          CORS / 请求体 / JSON 响应
├── scripts/
│   ├── init-tables.js  一次性建表（幂等）
│   ├── gen-codes.js    批量生成兑换码 + 导出 CSV
│   └── backfill-usage.js   使用流水回填（幂等）
├── package.json
└── .env.example        环境变量样例
```

## 本地开发

```bash
cd server
npm install
cp .env.example .env          # 填入真实值
npm run init-tables           # 首次：建表（users / redeem_codes / verify_codes / daily_limits / usage_log 等）
npm start                     # 启动，监听 http://localhost:9000
```

自测：

```bash
# 注册（拿 token）
curl -s localhost:9000/api/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"a@b.com","password":"123456","verifyCode":"123456"}'   # 先调 send-verify-code 拿真实验证码

# 生成并兑换一个码
npm run gen-codes -- 1 100     # 生成 1 个 100 额度的码，CSV 里能看到
TOKEN=... ; CODE=ENGT-...
curl -s localhost:9000/api/redeem -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\"}"

# 调 LLM（按 _operation 扣费，如 exampaper=5）
curl -s localhost:9000/api/llm/chat -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}'
```

## 部署

1. **本地装依赖**（务必带上 `node_modules`，函数平台通常不会自动 install）：
   ```bash
   cd server && npm install --omit=dev
   ```
2. **打包**：
   ```bash
   zip -rq ../engtools-api.zip src scripts package.json node_modules -x "*.env*"
   # ⚠️ 绝不把 .env 打进包：真实 LLM Key / JWT 密钥 / 数据库凭据只在服务端
   ```
3. 上传到你的运行平台（函数计算 / 容器 / VPS 均可），**启动命令** `node src/index.js`、**监听端口 9000**。
4. **环境变量**：把 `.env.example` 里的所有键配到平台的环境变量（`.env` 只用于本地）。
5. HTTP 入口设为直通（服务自身用 JWT 鉴权）；访问公网地址 `GET /` 返回 `{"ok":true}` 即部署成功。
6. 把公网地址填进前端的 `VITE_API_BASE`。

> 建表只需做一次：本地配好 `.env` 后 `npm run init-tables`，或在数据库平台控制台手建。

## 发卡流程

```bash
npm run gen-codes -- 50 100     # 50 个码，每个 100 额度 → 生成 codes-100pt-50.csv 并写入数据库
```

把 CSV 的 `code` 列作为库存上架第三方发卡平台（独角数卡/发卡网等），买家付款拿码 → 在站内「兑换码」处输入 → 额度到账。平台只做收银台，本服务是唯一真相源，无需对接回调。
