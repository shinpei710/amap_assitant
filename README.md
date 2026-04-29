# amap_assitant

把日本详细地址、Google Maps 长链接、经纬度转换成可在手机端打开高德地图的链接。

## Features

- Converts map links with embedded coordinates into AMap destination links.
- Expands short map links through the local backend when needed.
- Resolves detailed Japanese addresses by opening the map search result in Chromium and extracting coordinates from the final URL.
- Opens AMap destination pages first; route planning is left to AMap itself.
- Fails explicitly when no reliable coordinates are available. It does not generate keyword-search fallback links.

## Local Development

Requirements:

- Node.js 18+
- Chromium or Chrome installed locally

Start:

```bash
npm start
```

打开：

```text
http://localhost:5173
```

手机访问时可以把电脑和手机放在同一网络下，用电脑局域网 IP 访问，例如：

```text
http://192.168.1.10:5173
```

If Chromium is not in a common location, set:

```bash
CHROME_PATH=/path/to/chrome npm start
```

## Conversion Priority

1. Google Maps 长链接里的 `@lat,lng`、`!3dlat!4dlng` 或查询参数坐标。
2. `maps.app.goo.gl` 或 `goo.gl/maps` 短链接先由本地服务展开，再按长链接处理。
3. 展开后只有 `q=...` 或 `ftid=...` 而没有坐标时，直接失败，不用地点名猜测。
4. 直接输入的 `lat,lng` 或 `lng,lat`。
5. 日本详细地址经本地 Chromium 打开 Google Maps 搜索页，读取最终 URL 里的坐标。
6. 如果仍然没有可靠坐标，直接失败，不生成关键词搜索兜底。

## AMap Links

转换成功后会同时生成两类地点链接：

- 高德网页 URI：`https://uri.amap.com/...`，带 `callnative=1`，作为稳定兜底。
- 高德 App Scheme：iOS 使用 `iosamap://viewMap...`，Android 使用 `androidamap://viewMap...`。

主按钮会在手机端优先尝试打开高德地点页；如果系统没有拉起高德 App，用户可以点“跳转失败？点此手动跳转”打开高德网页 URI。这里不做自动回落，避免打断系统的 App 跳转确认弹窗。路线规划交给高德 App 内部完成。

## Verification

```bash
npm run check
npm test
```

## API

Health:

```text
GET /api/health
```

Expand a short map link:

```text
GET /api/expand?mode=auto&url=<short URL>
```

Resolve a detailed Japanese address:

```text
GET /api/geocode?mode=auto&q=<Japanese address>
```

## Deployment

This project needs a Node.js backend with Chromium. A static-only host will not run the short-link and address-resolution APIs.

The recommended release path is a Docker-capable host:

```bash
docker build -t amap_assitant .
docker run --rm -p 5173:5173 amap_assitant
```

See [DEPLOYMENT.md](./DEPLOYMENT.md) for Vercel notes and production options.

## Notes

This tool uses map links and coordinates supplied by the user. It is not affiliated with AMap or Google Maps.

## Legacy Debug Endpoints

Force browser expansion mode:

```text
/api/expand?mode=browser&url=<short URL>
```

Input still must look like a detailed Japanese address. Place names and keywords are rejected.
