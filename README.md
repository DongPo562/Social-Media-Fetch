# 今日头条收藏内容抓取与下载工具

本项目是一个基于 Node.js 和 Puppeteer 的自动化工具，用于抓取今日头条用户的“收藏”列表，并将收藏的文章和视频自动下载到本地。

## 功能特性

- **自动抓取收藏列表**：自动登录（需预先手动登录保留状态）并滚动加载收藏列表，提取标题、链接、分类和媒体类型。
- **数据持久化**：将抓取的数据保存到 Excel 文件 (`favorite.xlsx`) 中，方便查看和管理。
- **去重机制**：支持基于链接和标题的去重，避免重复抓取。
- **内容下载**：
  - **文章**：自动提取文章正文内容并保存为 `.txt` 文件。
  - **视频**：自动解析视频地址并下载为 `.mp4` 文件。
- **断点续传/重试**：记录下载状态，失败可重试，已下载内容自动跳过。
- **配置灵活**：通过 `config.ini` 配置文件调整抓取数量、超时时间、重试次数、保存路径等。

## 环境依赖

- Node.js (建议 v14+)
- Chrome/Chromium 浏览器 (Puppeteer 会自动下载，或使用本地安装的)

主要 npm 依赖：
- `puppeteer`: 用于浏览器自动化控制。
- `xlsx`: 用于读写 Excel 文件。
- `ini`: 用于解析配置文件。
- `axios`: 用于下载视频流和网络请求。

## 安装说明

1. 克隆或下载本项目代码。
2. 在项目根目录下打开终端，安装依赖：

```bash
npm install
```

## 配置说明

项目根目录下的 `config.ini` 文件用于配置运行参数：

```ini
[TouTiao]
fetch_count = 10              ; 每次抓取的条数
excel_path = favorite.xlsx    ; 数据保存的 Excel 文件名
enable_duplicate_check = true ; 是否启用去重

[Download]
enable_download = true        ; 抓取完成后是否自动开始下载
articles_folder = articles    ; 文章保存目录
videos_folder = videos        ; 视频保存目录
max_video_size = 500          ; 最大视频大小限制 (MB)
concurrent_downloads = 1      ; 并发下载数 (目前脚本逻辑主要为串行)

[Advanced]
retry_times = 2               ; 失败重试次数
timeout = 30000               ; 操作超时时间 (毫秒)
enable_log = true             ; 是否启用日志文件记录
headless = false              ; 是否使用无头模式 (不显示浏览器界面)
```

## 使用说明

### 1. 首次运行与登录

由于今日头条有较严格的登录验证，首次使用建议先手动登录以保存会话状态：

1. 运行 `get_favorite.js` (默认配置 `headless = false` 会打开浏览器窗口)。
2. 当浏览器打开并跳转到今日头条首页时，**手动在浏览器中进行登录**。
3. 登录成功后，脚本会将登录状态（Cookies 等）保存到 `user_data` 目录中。
4. 后续运行即可自动复用登录状态。

### 2. 抓取收藏列表

运行以下命令开始抓取收藏列表：

```bash
node get_favorite.js
```

脚本逻辑：
- 启动浏览器，进入个人中心 -> 收藏页面。
- 滚动加载并提取指定数量 (`fetch_count`) 的收藏内容。
- 将新内容保存到 `favorite.xlsx`。
- 如果配置了 `enable_download = true`，会自动启动下载流程。

### 3. 仅下载内容

如果你已经抓取了数据到 Excel，但想单独运行下载任务（例如之前的下载中断了），可以运行：

```bash
node download_content.js
```

脚本逻辑：
- 读取 `favorite.xlsx`。
- 查找“是否下载”标记为 `0` (未下载) 或 `2` (失败且配置允许重试) 的条目。
- 逐个下载文章或视频到 `articles` 或 `videos` 目录。
- 更新 Excel 中的下载状态和本地文件路径。

## 文件结构

- `get_favorite.js`: 主程序，负责抓取收藏列表。
- `download_content.js`: 下载模块，负责下载具体的文章和视频。
- `config.ini`: 配置文件。
- `favorite.xlsx`: 存储收藏数据和下载状态的数据库文件。
- `user_data/`: 存放 Chrome 用户数据（包含登录状态）。
- `articles/`: 默认的文章下载目录。
- `videos/`: 默认的视频下载目录。
- `screenshot_with_login.js`: 测试脚本，用于验证登录状态和简单获取标题。

## 注意事项

- **反爬虫机制**：如果频繁遇到验证码或无法加载，请适当降低抓取频率，或手动在弹出的浏览器窗口中完成验证。
- **视频下载**：部分视频可能采用 Blob 加密流或其他复杂格式，可能无法直接下载，脚本会记录错误信息。
- **登录失效**：如果长时间未运行，登录状态可能失效，需要重新手动登录。
