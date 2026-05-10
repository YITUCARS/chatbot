# yitu 智能客服

租车公司客服系统，三层回答策略：

1. **话术匹配**（关键词秒回）
2. **知识库检索**（Top 5 相关条目）
3. **AI 生成**（Claude / OpenAI，基于知识库回答，严格避免胡编）

技术栈：Node 18+ / Express / better-sqlite3 / 原生 HTML 前端，全部数据存 `data/yitu.db` 单文件，便于备份和迁移。

---

## 快速开始

```bash
# 1. 进入项目目录
cd yitu-server

# 2. 复制环境变量模板，编辑 SESSION_SECRET（随机长字符串）
cp .env.example .env
# 用 openssl 生成：
#   openssl rand -hex 32
# 把结果填进 SESSION_SECRET=

# 3. 安装依赖
npm install

# 4. 启动
npm start
```

启动后控制台会打印：

```
  yitu 智能客服服务已启动
  ▸ 后台管理:  http://localhost:3000/admin   (默认密码 admin123)
  ▸ H5 客服:   http://localhost:3000/chat
```

首次启动会自动建库 + 灌入 10 条示例话术、8 条示例知识、默认设置。

---

## 配置 API Key

1. 浏览器打开 `http://localhost:3000/admin`
2. 用 `admin123` 登录 → **立即在「系统设置 → 修改后台密码」改密码**
3. 在「系统设置 → AI 模型」选择服务商：
   - **Claude**：粘贴 `sk-ant-...` 形式的 Anthropic API Key
   - **OpenAI**：粘贴 `sk-...` 形式的 OpenAI API Key
4. 点「保存」→ 再点「测试连接」，看到 `✓ 连接成功` 即可
5. 用手机访问 `http://<你电脑的局域网 IP>:3000/chat` 实测一下

> Key 保存在服务器数据库里，**不会出现在前端代码或浏览器中**。后台读取时返回掩码（`sk-a***xxxx`），留空表示不修改。

---

## 部署到线上（微信里要用必须 HTTPS）

### 方案 A：Caddy（推荐，自动 HTTPS）

```bash
# /etc/caddy/Caddyfile
your-domain.com {
  reverse_proxy localhost:3000
}
```

Caddy 自动签 Let's Encrypt 证书。设好 A 记录 `your-domain.com → 服务器 IP`，重启 Caddy 即可。

### 方案 B：Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;
    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}
```

证书申请：`sudo certbot --nginx -d your-domain.com`

### 用 PM2 守护进程

```bash
npm install -g pm2
pm2 start server.js --name yitu
pm2 startup    # 跟着提示走，开机自启
pm2 save
```

### 微信里使用

把这条链接发到群里或公众号菜单：
```
https://your-domain.com/chat
```

客人点开就是全屏 H5 客服，**不需要登录、不需要小程序**。

---

## 维护

### 知识库维护建议

- **一条知识聚焦一个问题点**（押金、保险、违章），别把 5 个话题塞一条
- **关键词要写用户会说的口语词**，比如「押金多少」而不是「押金标准」
- **内容里直接列价格、流程、规则**，AI 会原样引用，别绕弯子

### 数据库备份

```bash
cp data/yitu.db data/yitu.db.backup-$(date +%Y%m%d)
```

建议加个 cron：

```cron
0 3 * * * cd /path/to/yitu-server && cp data/yitu.db data/yitu.db.backup-$(date +\%Y\%m\%d)
```

### 查看实时日志

```bash
pm2 logs yitu
```

### 重置后台密码（忘记密码时）

```bash
# 进入项目目录，删除密码哈希记录，重启服务后会用 admin123 重置
sqlite3 data/yitu.db "DELETE FROM settings WHERE key='admin_password_hash';"
```
然后到「系统设置」立即改新密码。

---

## 常见问题

**Q：端口被占用**
改 `.env` 里 `PORT=3001`，或杀掉占用进程 `lsof -i:3000` 找到 PID `kill -9 <PID>`

**Q：better-sqlite3 安装报错**
需要本机有编译工具：
- macOS: `xcode-select --install`
- Linux: `apt install build-essential python3`

**Q：CORS 报错**
开发模式（`NODE_ENV != production`）自动放行所有 localhost。生产环境把允许的域名加进 `.env` 的 `CORS_ORIGINS=`（逗号分隔）。

**Q：微信里打不开**
1. 必须 HTTPS
2. 域名要备案（国内服务器）
3. 检查微信浏览器 UA 没被你的 nginx/caddy 拦截

**Q：AI 回答太死板/胡编**
- 太死板 → 调「系统提示词」放松要求
- 胡编 → 检查是否检索到了知识库（统计页看 `RAG 回答` 数），如果都是 `AI 通用` 说明知识库没命中，需要补关键词或加新条目

---

## 项目结构

```
yitu-server/
├── server.js              # Express 入口
├── package.json
├── .env.example
├── data/                  # SQLite 数据库目录（运行时生成）
├── public/
│   ├── yitu-admin.html   # 后台
│   └── yitu-chat.html    # H5 客服
└── lib/
    ├── db.js              # SQLite 封装
    ├── seed.js            # 示例数据
    ├── rag.js             # 关键词检索
    └── ai.js              # Claude / OpenAI 调用
```
