# Deployment

`amap_assitant` 需要一个 Node.js 后端服务，纯静态托管无法完整运行全部功能。

## 推荐方式

优先选择支持常驻 Node 服务或 Docker 容器的平台，例如：

- Render
- Fly.io
- Railway
- VPS / 自有服务器

## Docker

```bash
docker build -t amap_assitant .
docker run --rm -p 5173:5173 amap_assitant
```

可配置环境变量：

- `PORT`：服务端口，默认 `5173`
- `CONTACT_EMAIL`：可选，用于服务端请求标识

健康检查：

```text
/api/health
```

## Vercel

Vercel 适合部署静态前端和 Serverless Functions，但当前项目按一个完整 Node 服务组织。若要使用 Vercel，建议拆分为：

1. 前端部署到 Vercel。
2. 后端部署到支持 Node 服务或 Docker 的平台。
3. 前端通过环境变量访问后端 API。

首个公开版本建议先使用单一后端服务部署，链路更简单，排查也更直接。
