const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const ini = require('ini');
const XLSX = require('xlsx');
const axios = require('axios');

// Load Config
const configPath = path.join(__dirname, 'config.ini');
let config = {};
try {
    config = ini.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (e) {
    console.error("Config file not found or invalid, using defaults.");
}

const DOWNLOAD_CONFIG = config.Download || {};
const ADVANCED_CONFIG = config.Advanced || {};

const ENABLE_DOWNLOAD = DOWNLOAD_CONFIG.enable_download !== false;
const ARTICLES_FOLDER = path.resolve(__dirname, DOWNLOAD_CONFIG.articles_folder || 'articles');
const VIDEOS_FOLDER = path.resolve(__dirname, DOWNLOAD_CONFIG.videos_folder || 'videos');
const MAX_VIDEO_SIZE_MB = parseInt(DOWNLOAD_CONFIG.max_video_size || 500);
const DOWNLOAD_TIMEOUT = parseInt(DOWNLOAD_CONFIG.download_timeout || 600000);
const PAGE_LOAD_TIMEOUT = parseInt(DOWNLOAD_CONFIG.page_load_timeout || 30000);
const RETRY_TIMES = parseInt(DOWNLOAD_CONFIG.retry_times || 1);
const RETRY_FAILED = DOWNLOAD_CONFIG.retry_failed === true || DOWNLOAD_CONFIG.retry_failed === 'true';

const EXCEL_PATH = path.resolve(__dirname, config.TouTiao?.excel_path || 'favorite.xlsx');
const ENABLE_LOG = ADVANCED_CONFIG.enable_log !== false;
const HEADLESS = ADVANCED_CONFIG.headless === true || ADVANCED_CONFIG.headless === 'true';

// Helpers
function log(msg) {
    console.log(msg);
    if (ENABLE_LOG) {
        try {
            fs.appendFileSync(path.join(__dirname, 'download_log.txt'), `[${new Date().toISOString()}] ${msg}\n`);
        } catch (e) {}
    }
}

function errorLog(msg, error, item = null) {
    console.error(msg, error ? error.message : '');
    if (ENABLE_LOG) {
        const logEntry = `[${new Date().toISOString()}] ERROR: ${msg}\n${error ? error.stack : ''}\nItem: ${JSON.stringify(item)}\n\n`;
        try {
            fs.appendFileSync(path.join(__dirname, 'error_log.txt'), logEntry);
        } catch (e) {}
    }
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function getExcelData() {
    if (!fs.existsSync(EXCEL_PATH)) return [];
    const workbook = XLSX.readFile(EXCEL_PATH);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet);
}

function updateExcelStatus(id, status, localPath, errorMsg = '') {
    const workbook = XLSX.readFile(EXCEL_PATH);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet);

    const index = data.findIndex(r => r['编号'] == id);
    if (index !== -1) {
        data[index]['是否下载'] = status;
        data[index]['本地地址'] = localPath || errorMsg;
        
        const newSheet = XLSX.utils.json_to_sheet(data, { 
            header: ['编号', '标题', '媒体类型', '分类', '链接', '保存日期', '是否下载', '本地地址'] 
        });
        workbook.Sheets[sheetName] = newSheet;
        XLSX.writeFile(workbook, EXCEL_PATH);
    }
}

async function downloadArticle(page, item) {
    log(`[文章] 正在处理: ${item['标题']}`);
    
    // Create directory
    const dateStr = item['保存日期'] || new Date().toISOString().split('T')[0];
    const targetDir = path.join(ARTICLES_FOLDER, dateStr);
    ensureDir(targetDir);
    const fileName = `${item['编号']}.txt`;
    const filePath = path.join(targetDir, fileName);

    // Open Page
    try {
        await page.goto(item['链接'], { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT });
    } catch (e) {
        throw new Error(`页面加载失败: ${e.message}`);
    }

    // Wait for content
    try {
        // Try multiple selectors
        await page.waitForSelector('article, .article-content, h1', { timeout: 15000 });
    } catch (e) {
        // If timeout, maybe it's a different structure or login required, but we try to proceed to extraction
        log("警告: 等待文章元素超时，尝试直接提取...");
    }

    // Extract Content
    const content = await page.evaluate(() => {
        // Title
        let title = document.title;
        const h1 = document.querySelector('h1');
        if (h1) title = h1.innerText.trim();

        // Content
        // Priority: specific article containers
        let contentEl = document.querySelector('article') || 
                        document.querySelector('.article-content') || 
                        document.querySelector('.tt-article-content'); // Toutiao specific class often used
        
        // Fallback: finding the container with most text paragraphs
        if (!contentEl) {
            const divs = document.querySelectorAll('div');
            let maxP = 0;
            for (const div of divs) {
                const pCount = div.querySelectorAll('p').length;
                if (pCount > maxP) {
                    maxP = pCount;
                    contentEl = div;
                }
            }
        }

        if (!contentEl) return null;

        let text = '';
        // Extract text from paragraphs to keep structure
        const paragraphs = contentEl.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li');
        if (paragraphs.length > 0) {
            paragraphs.forEach(p => {
                const t = p.innerText.trim();
                if (t) text += t + '\n\n';
            });
        } else {
            text = contentEl.innerText;
        }

        return { title, text };
    });

    if (!content || !content.text || content.text.length < 10) {
        throw new Error("提取文章内容失败或内容过短");
    }

    // Save File
    const fileContent = `${content.title}\n\n${content.text}`;
    fs.writeFileSync(filePath, fileContent, 'utf-8');
    log(`✓ 文章已保存: ${filePath}`);
    
    return path.relative(__dirname, filePath);
}

async function downloadVideo(page, item) {
    log(`[视频] 正在处理: ${item['标题']}`);

    // Create directory
    const dateStr = item['保存日期'] || new Date().toISOString().split('T')[0];
    const targetDir = path.join(VIDEOS_FOLDER, dateStr);
    ensureDir(targetDir);
    const fileName = `${item['编号']}.mp4`;
    const filePath = path.join(targetDir, fileName);

    // Setup network interception for video url
    let videoUrl = null;
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');
    
    // Listener for media
    const responseHandler = (event) => {
        if (videoUrl) return;
        const resp = event.response;
        if (resp.mimeType && (resp.mimeType.includes('video/mp4') || resp.mimeType.includes('video/webm'))) {
            // Filter out small segments if possible, but for now take first valid video
            // Toutiao often serves blob: or direct mp4
            if (resp.url.startsWith('http')) {
                videoUrl = resp.url;
            }
        }
    };
    client.on('Network.responseReceived', responseHandler);

    // Open Page
    try {
        await page.goto(item['链接'], { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT });
    } catch (e) {
        throw new Error(`页面加载失败: ${e.message}`);
    }

    // Wait for video element
    try {
        await page.waitForSelector('video', { timeout: 15000 });
    } catch (e) {
        log("警告: 未找到video标签，等待网络请求捕获...");
    }

    // Give some time for media requests
    await new Promise(r => setTimeout(r, 5000));

    // Try to get src from video tag if network intercept didn't work
    if (!videoUrl) {
        videoUrl = await page.evaluate(() => {
            const v = document.querySelector('video');
            if (v) return v.src;
            return null;
        });
    }
    
    // Try to find in page source (window.__INITIAL_STATE__ etc) - Fallback
    if (!videoUrl || videoUrl.startsWith('blob:')) {
        // Blob URLs cannot be downloaded directly by nodejs easily without context
        // Try to find the real source in scripts
        const scriptUrl = await page.evaluate(() => {
            const scripts = document.querySelectorAll('script');
            for (const s of scripts) {
                const c = s.innerText;
                if (c.includes('video_url')) {
                    // Simple regex extract attempt (very rough)
                    const match = c.match(/"video_url"\s*:\s*"([^"]+)"/);
                    if (match) return JSON.parse(`"${match[1]}"`); // unescape
                }
            }
            return null;
        });
        if (scriptUrl) videoUrl = window.atob(scriptUrl); // Sometimes base64? No, usually just escaped.
        // Actually specialized parsers are better, but let's stick to what we found or just fail if blob
        if (scriptUrl) videoUrl = scriptUrl;
    }

    if (!videoUrl || videoUrl.startsWith('blob:')) {
        // If we still have a blob url, we might need to use puppeteer to fetch it as blob and convert to buffer
        // But for now, let's error if we can't get a http url
        throw new Error("无法获取有效的视频下载地址 (可能是Blob加密流)");
    }

    log(`找到视频地址: ${videoUrl.substring(0, 50)}...`);

    // Check size
    try {
        const head = await axios.head(videoUrl);
        const size = parseInt(head.headers['content-length'] || 0);
        const sizeMB = size / (1024 * 1024);
        if (sizeMB > MAX_VIDEO_SIZE_MB) {
            throw new Error(`视频大小 (${sizeMB.toFixed(2)}MB) 超过限制 (${MAX_VIDEO_SIZE_MB}MB)`);
        }
        log(`视频大小: ${sizeMB.toFixed(2)} MB`);
    } catch (e) {
        log(`无法获取视频大小，直接尝试下载... (${e.message})`);
    }

    // Download
    log("开始下载视频流...");
    const writer = fs.createWriteStream(filePath);
    
    const response = await axios({
        url: videoUrl,
        method: 'GET',
        responseType: 'stream',
        timeout: DOWNLOAD_TIMEOUT
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', () => {
            log(`✓ 视频已保存: ${filePath}`);
            resolve(path.relative(__dirname, filePath));
        });
        writer.on('error', (err) => {
            fs.unlink(filePath, () => {}); // Delete partial file
            reject(new Error(`写入文件失败: ${err.message}`));
        });
    });
}

(async () => {
    if (!ENABLE_DOWNLOAD) {
        log("下载功能未启用 (config.ini [Download] enable_download=false)");
        return;
    }

    ensureDir(ARTICLES_FOLDER);
    ensureDir(VIDEOS_FOLDER);

    log("=========================================");
    log("今日头条收藏内容下载工具");
    log("=========================================");

    const allData = getExcelData();
    let tasks = allData.filter(item => {
        const status = parseInt(item['是否下载']);
        if (status === 0) return true;
        if (RETRY_FAILED && status === 2) return true;
        return false;
    });

    if (tasks.length === 0) {
        log("没有需要下载的任务。");
        return;
    }

    log(`待处理任务: ${tasks.length} 条`);
    log(`文章保存路径: ${ARTICLES_FOLDER}`);
    log(`视频保存路径: ${VIDEOS_FOLDER}`);

    const browser = await puppeteer.launch({
        headless: HEADLESS,
        userDataDir: path.join(__dirname, 'user_data'),
        defaultViewport: null,
        args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox']
    });

    // Reuse one page for all tasks
    const page = await browser.newPage();
    // Set a generic user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < tasks.length; i++) {
        const item = tasks[i];
        const indexStr = `[${i + 1}/${tasks.length}]`;
        log(`\n${indexStr} 开始处理 编号:${item['编号']} 类型:${item['媒体类型']}`);

        let retry = 0;
        let success = false;
        let errorMsg = '';

        while (retry <= RETRY_TIMES && !success) {
            if (retry > 0) log(`  正在重试 (${retry}/${RETRY_TIMES})...`);
            
            try {
                let localPath = '';
                if (item['媒体类型'] === '文章') {
                    localPath = await downloadArticle(page, item);
                } else if (item['媒体类型'] === '视频') {
                    localPath = await downloadVideo(page, item);
                } else {
                    log("  跳过: 未知媒体类型");
                    // Treat as handled but skipped
                    updateExcelStatus(item['编号'], 1, "Skipped: Unknown Type");
                    success = true; 
                    continue;
                }
                
                updateExcelStatus(item['编号'], 1, localPath);
                success = true;
                successCount++;

            } catch (e) {
                errorMsg = e.message;
                log(`  ✗ 失败: ${errorMsg}`);
                retry++;
                // Wait before retry
                if (retry <= RETRY_TIMES) await new Promise(r => setTimeout(r, 5000));
            }
        }

        if (!success) {
            updateExcelStatus(item['编号'], 2, '', errorMsg);
            errorLog(`下载失败 编号:${item['编号']}`, { message: errorMsg, stack: '' }, item);
            failCount++;
        }
    }

    log("\n=========================================");
    log("下载任务完成");
    log(`成功: ${successCount}`);
    log(`失败: ${failCount}`);
    log("=========================================");

    await browser.close();
})();
