本项目是一个基于 Node.js 和 Puppeteer 的自动化工具，用于抓取今日头条用户的"收藏"列表，并将收藏的文章和视频自动下载到本地，同时支持将文章内容同步到 Notion。npm installpip install requestsNOTION_TOKEN=your_notion_integration_token
PAGE_ID=your_parent_page_id项目根目录下的 config.ini 文件用于配置运行参数：[TouTiao]
fetch_count = 10              ; 每次抓取的条数
excel_path = favorite.xlsx    ; 数据保存的 Excel 文件名
enable_duplicate_check = true ; 是否启用去重

[Download]
enable_download = true        ; 抓取完成后是否自动开始下载
articles_folder = articles    ; 文章保存目录
videos_folder = videos        ; 视频保存目录
max_video_size = 500          ; 最大视频大小限制 (MB)
concurrent_downloads = 1      ; 并发下载数

[Notion]
enable_notion_sync = true     ; 是否启用 Notion 同步
database_id = xxx             ; Notion 数据库 ID (从数据库 URL 获取)
retry_failed = true           ; 是否重试失败的同步

[Advanced]
retry_times = 2               ; 失败重试次数
timeout = 30000               ; 操作超时时间 (毫秒)
enable_log = true             ; 是否启用日志文件记录
headless = false              ; 是否使用无头模式由于今日头条有较严格的登录验证，首次使用建议先手动登录以保存会话状态：运行以下命令开始抓取收藏列表：node get_favorite.js脚本逻辑：如果你已经抓取了数据到 Excel，但想单独运行下载任务（例如之前的下载中断了），可以运行：node download_content.js脚本逻辑：将已下载的文章同步到 Notion：node sync_to_notion.js脚本逻辑：验证 Notion API 配置是否正确：python connectNotion.py此脚本会测试读取页面、读取内容块和添加内容的权限。├── get_favorite.js          # 主程序，负责抓取收藏列表
├── download_content.js      # 下载模块，负责下载具体的文章和视频
├── sync_to_notion.js        # Notion 同步模块，负责将文章上传到 Notion
├── excel_utils.js           # Excel 读写工具模块
├── notion_uploader.py       # Python 脚本，通过 Notion API 创建页面
├── connectNotion.py         # Notion 连接测试脚本
├── screenshot_with_login.js # 测试脚本，用于验证登录状态
├── config.ini               # 配置文件
├── .env                     # 环境变量（Notion Token 等，需自行创建）
├── favorite.xlsx            # 存储收藏数据和状态的数据库文件
├── user_data/               # 存放 Chrome 用户数据（包含登录状态）
├── articles/                # 默认的文章下载目录
├── articles_markdown/       # Markdown 格式文章目录
└── videos/                  # 默认的视频下载目录favorite.xlsx 包含以下列：