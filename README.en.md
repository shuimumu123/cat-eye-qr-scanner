# Cat Eye QR Scanner

A web QR-code scanner userscript in a "night cat-eye" style, running on Tampermonkey / Violentmonkey. A dark-glass panel with night-vision teal glow — easy to spot even on light pages.

[简体中文](README.md) | **English**

## Features

- **Manual selection scan** — drag a scan box and decode any QR code inside `<img>` or `<canvas>` elements
- **Auto scan** — scan every visible image in the viewport at once; matches get an outline and a click copies their links
- **Screenshot fallback** — when an image is cross-origin and unreadable, the region is captured with html2canvas and decoded
- **Pan link cleanup** — extracts Baidu Pan links from QR text and fills in the `?pwd=` code
- **History** — keeps the 15 most recent results with timestamps and one-click copy
- **UI** — night-cat floating ball (breathing glow), collapsible panel, remembered position and size, pin-to-screen mode, 10–30px font size
- **Shortcut** — `Ctrl + Shift + F` triggers auto scan

## Install

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) or Violentmonkey
2. Open `cat-eye-qr-scanner.user.js` in this repository
3. Click **Raw** in the top-right corner; your manager shows the install page — click **Install**

Install URL:

```
https://raw.githubusercontent.com/shuimumu123/cat-eye-qr-scanner/main/cat-eye-qr-scanner.user.js
```

## Auto-update

The script ships with `@updateURL` / `@downloadURL`, so **one install is enough** — new releases are picked up automatically.

- Source: `cat-eye-qr-scanner.user.js` on the `main` branch of this repository
- Check interval: Tampermonkey checks about every 24 hours by default (configurable); you can also trigger "Check for updates" manually
- A new release is detected only when `@version` increases

If `raw.githubusercontent.com` is slow or blocked in your network, replace those two metadata lines with the jsDelivr mirror (it caches for 1–12 hours):

```
// @updateURL    https://cdn.jsdelivr.net/gh/shuimumu123/cat-eye-qr-scanner@main/cat-eye-qr-scanner.user.js
// @downloadURL  https://cdn.jsdelivr.net/gh/shuimumu123/cat-eye-qr-scanner@main/cat-eye-qr-scanner.user.js
```

## Usage

| Action | Description |
| --- | --- |
| Click the cat ball | Expand the main panel |
| 📷 Scan web QR code | Drag/resize the scan box (8 handles), then click "识别二维码" (decode) |
| 🔍 Auto scan page | Scans visible images; click a teal-glowing image to copy its links |
| ◷ History | Review the last 15 results |
| ⚙ Settings | Pin panel, font size, reset scan box / panel position |
| Esc | Cancel the current selection |
| Ctrl + Shift + F | Same as "Auto scan page" |

Scan box position, panel position/size and font size are all remembered automatically.

## Compatibility

- Chrome / Edge / Firefox with Tampermonkey or Violentmonkey
- Requires the `GM_xmlhttpRequest` grant to read cross-origin images
- jsQR and html2canvas are loaded from the jsDelivr CDN via `@require`
- Matches all sites (`*://*/*`), `@noframes` by default

## Changelog

### 8.7

- Look: the whole UI is now the "night cat-eye" theme — dark-glass panel with night-vision teal glow, new cat-eye icons in the title and floating ball
- Look: scanning frame gains corner brackets and a sweeping light beam
- Look: auto-scan matches now get a teal glow outline that turns amber on hover
- Misc: title text has a faint teal glow; animations respect `prefers-reduced-motion`

### 8.6.1

- Metadata: added `@updateURL` / `@downloadURL` / `@homepageURL` / `@supportURL` so installs follow the repository automatically

### 8.6

- Perf: auto scan drops from 22 to 5 jsQR calls per image (about −77%)
- Perf: the 2000px retry reuses the already-decoded image instead of downloading it again
- Perf: GM storage reads are cached in memory, so window resizing no longer hammers IPC
- Fix: double-clicking a scan button no longer runs parallel recognition flows
- Fix: non-http(s) payloads such as `javascript:` no longer produce clickable links
- Fix: scan-box action buttons no longer overflow the viewport; Esc cancels
- Fix: a hung request no longer leaves the loading overlay on screen

### 8.5

- Fixed cross-origin image decoding and the small-QR second pass
- Fixed position memory, font-size input, request timeouts and link safety

## Releasing a new version (maintainer)

1. Bump `@version` in the script (e.g. `8.6.1` → `8.7`); users are not updated unless the version increases
2. Overwrite the file **with the same name** on the `main` branch (on GitHub: Add file → Upload files → drag in → Commit changes)
3. Installed copies update on their next check; new users just open the install URL

Do not rename or move the file, otherwise `@updateURL` returns 404 and auto-update silently stops working.

## Notes

- History lives only in your userscript manager's local storage; nothing is collected or uploaded
- For learning and personal use only — please respect the terms of service of the sites you visit

## Repository layout

```
cat-eye-qr-scanner.user.js   # the userscript itself, installable from Tampermonkey
README.md                    # 简体中文 documentation
README.en.md                 # English documentation (this file)
```
