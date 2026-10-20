# 猫眼扫描工具

**简体中文** | [English](README.en.md)

蓝白 iOS 风格的网页二维码扫描用户脚本，基于 Tampermonkey / Violentmonkey 运行。

## 功能

- **手动框选扫描**：拖出一个扫描框，识别框内 `<img>` 和 `<canvas>` 里的二维码
- **自动扫描页面**：一次扫描当前视口所有可见图片，命中的图片描边高亮，点击即可复制链接
- **截图兜底**：图片跨域读不到时，用 html2canvas 截取该区域再识别
- **网盘链接整理**：自动从二维码文本中提取百度网盘链接，并补全 `?pwd=` 提取码
- **历史记录**：保留最近 15 条，带扫描时间，可一键复制
- **界面**：蓝白小猫悬浮球、可折叠主面板、位置与尺寸记忆、固定悬浮窗、字号 10–30px 可调
- **快捷键**：`Ctrl + Shift + F` 触发自动扫描

## 安装

1. 先安装脚本管理器：[Tampermonkey](https://www.tampermonkey.net/) 或 Violentmonkey
2. 打开本仓库的 `cat-eye-qr-scanner.user.js`
3. 点右上角 **Raw**，脚本管理器会弹出安装页，点「安装」

安装地址（把 `<你的用户名>` 换成你的 GitHub 用户名）：

```[
https://raw.githubusercontent.com/shuimumu123/cat-eye-qr-scanner/main/cat-eye-qr-scanner.user.js
```

## 使用

| 操作 | 说明 |
| --- | --- |
| 点击小猫悬浮球 | 展开主面板 |
| 📷 扫描网页二维码 | 出现扫描框，拖动/八向缩放后点「识别二维码」 |
| 🔍 自动扫描页面 | 扫描视口内图片，橙色描边的图片点一下即复制其链接 |
| ◷ 历史记录 | 查看最近 15 条扫描结果 |
| ⚙ 设置 | 固定悬浮窗、字号、恢复扫描框/面板位置 |
| Esc | 取消当前框选 |
| Ctrl + Shift + F | 同「自动扫描页面」 |

扫描框位置、面板位置与大小、字号都会自动记忆。

## 兼容性

- Chrome / Edge / Firefox + Tampermonkey 或 Violentmonkey
- 需要 `GM_xmlhttpRequest` 权限，用于读取跨域图片
- `@require` 的 jsQR 与 html2canvas 来自 jsDelivr CDN
- 匹配所有站点（`*://*/*`），默认 `@noframes`

## 更新日志

### 8.6

- 性能：自动扫描每张图的 jsQR 调用从 22 次降到 5 次（约 −77%）
- 性能：1200px 失败后重试 2000px 时复用已解码的图片，不再重新下载
- 性能：GM 存储读取改为内存缓存，窗口缩放时不再反复 IPC
- 修复：连点按钮会并行跑多份识别流程
- 修复：`javascript:` 等非 http(s) 的二维码内容不再生成可点击链接
- 修复：扫描框按钮在视口边缘会跑出屏幕；Esc 可以取消
- 修复：请求挂起导致 loading 遮罩不消失

### 8.5

- 修复跨域图片识别、小二维码二次放大
- 修正位置记忆、字体输入、请求超时与链接安全

## 说明

- 历史记录只保存在本地脚本管理器的存储里，脚本不收集、不上传任何数据
- 仅供学习与个人使用，请遵守所访问网站的服务条款

## 目录结构

```
cat-eye-qr-scanner.user.js   # 用户脚本本体，Tampermonkey 直接安装
README.md                    # 简体中文说明（本文件）
README.en.md                 # English documentation
```
