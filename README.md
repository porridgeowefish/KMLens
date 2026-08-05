# KMLens

**A local-first KML & GPX viewer for Windows.**

KMLens 是一个轻量、开源的 Windows 地理文件检视器。它可以直接打开 KML 与 GPX 文件，查看点位、轨迹、区域、海拔和里程；文件解析全部在本机完成，不会上传到服务器。

## 下载

前往 [GitHub Releases](https://github.com/porridgeowefish/KMLens/releases/latest) 下载最新的 `KMLens-Setup-*.exe`。

安装程序会为当前用户安装 KMLens、创建快捷方式，并注册 `.kml` 和 `.gpx` 文件关联，不需要管理员权限。由于项目暂未购买商业代码签名证书，Windows SmartScreen 可能显示“未知发布者”。

## 功能

- 解析 KML 点、线、面及 `gx:Track`；
- 解析 GPX 轨迹、路线和路点；
- 多文件叠加、图层显隐与自动定位；
- 统计里程、累计爬升、海拔和记录时长；
- OpenStreetMap 街道底图与离线坐标网格；
- 导出 GeoJSON；
- 双击 KML / GPX 文件直接打开；
- 自动检查 GitHub Release 更新并校验 SHA-256。

## 隐私

KML 和 GPX 内容只在本机读取和解析。应用不会上传地理文件。使用街道底图时会向 OpenStreetMap 请求地图瓦片；切换至“坐标网格”后可在不加载在线底图的状态下查看数据。

## 本地开发

需要 Node.js 22、Go 1.25、[Wails v2](https://wails.io/) 和 Windows WebView2。

```powershell
npm install
npm run desktop:build
wails dev
```

运行测试：

```powershell
npm run desktop:check
go test ./...
```

生成 Windows 安装包（还需要 NSIS）：

```powershell
.\scripts\build-lite.ps1 -Version 0.3.0 `
  -UpdateSource "https://github.com/porridgeowefish/KMLens/releases/latest/download/latest.json"
```

构建产物会写入 `release-lite/`。推送形如 `v0.3.0` 的标签后，GitHub Actions 也会自动构建并发布安装包与更新清单。

## License

[MIT](LICENSE) © 2026 porridgeowefish
