# amap_assitant

把日本详细地址、Google 地图链接或经纬度转换成可在手机端打开的高德地图地点链接。

## 功能

- 支持日本详细地址、Google 地图链接、经纬度输入。
- 生成高德地点页链接，并在手机端优先尝试拉起高德 App。
- 不使用地点名做模糊搜索兜底；没有可靠坐标时会明确失败。
- 保留网页备用链接，App 没有打开时可以手动跳转。

## 本地运行

需要 Node.js 18+。

```bash
npm install
npm start
```

打开：

```text
http://localhost:5173
```

手机访问时，把电脑和手机放在同一网络下，用电脑局域网 IP 打开，例如：

```text
http://192.168.1.10:5173
```

## 使用方式

1. 粘贴日本详细地址、Google 地图链接或经纬度。
2. 点击“先预览”查看坐标和地图预览。
3. 点击“送去高德”打开高德地点页。
4. 如 App 未打开，点击“跳转失败？点此手动跳转”。

## 验证

```bash
npm run check
npm test
```

## 部署

项目包含一个 Node.js 后端，静态托管无法完整运行全部功能。推荐使用支持 Node 服务或 Docker 的平台部署。

Docker 示例：

```bash
docker build -t amap_assitant .
docker run --rm -p 5173:5173 amap_assitant
```

更多部署说明见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 说明

本项目只是一个个人出行辅助工具，用于把用户输入的位置转换为高德地图可打开的地点链接。请在出行前自行核对目的地位置。
