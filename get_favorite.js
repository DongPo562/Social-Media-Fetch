const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const ini = require('ini');
const XLSX = require('xlsx');

// Load Config
const configPath = path.join(__dirname, 'config.ini');
let config = {};
try {
    config = ini.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (e) {
    console.error("Config file not found or invalid, using defaults.");
}

const TOUTIAO_CONFIG = config.TouTiao || {};
const ADVANCED_CONFIG = config.Advanced || {};
const DOWNLOAD_CONFIG = config.Download || {};

const FETCH_COUNT = parseInt(TOUTIAO_CONFIG.fetch_count || 10);
const EXCEL_PATH = path.resolve(__dirname, TOUTIAO_CONFIG.excel_path || 'favorite.xlsx');
const ENABLE_DUPLICATE_CHECK = TOUTIAO_CONFIG.enable_duplicate_check !== false;
const RETRY_TIMES = parseInt(ADVANCED_CONFIG.retry_times || 3);
const TIMEOUT = parseInt(ADVANCED_CONFIG.timeout || 30000);
const ENABLE_LOG = ADVANCED_CONFIG.enable_log !== false;
const HEADLESS = ADVANCED_CONFIG.headless === true || ADVANCED_CONFIG.headless === 'true';

// Logging Helpers
function log(msg) {
    console.log(msg);
}

function errorLog(msg, error) {
    console.error(msg, error);
    if (ENABLE_LOG) {
        const logEntry = `[${new Date().toISOString()}] ${msg}\n${error ? error.stack : ''}\n\n`;
        try {
            fs.appendFileSync(path.join(__dirname, 'error_log.txt'), logEntry);
        } catch (e) {
            console.error("Failed to write error log", e);
        }
    }
}

function writeFetchLog(successCount, newCount, duplicateCount) {
    if (!ENABLE_LOG) return;
    const logEntry = `[${new Date().toISOString()}] Total Fetched: ${successCount}, New: ${newCount}, Duplicate: ${duplicateCount}, File: ${EXCEL_PATH}\n`;
    try {
        fs.appendFileSync(path.join(__dirname, 'fetch_log.txt'), logEntry);
    } catch (e) {
        console.error("Failed to write fetch log", e);
    }
}

// Excel Helpers
function initializeExcel() {
    if (!fs.existsSync(EXCEL_PATH)) {
        return;
    }
    
    log("=========================================");
    log("正在读取Excel文件...");
    
    try {
        const workbook = XLSX.readFile(EXCEL_PATH);
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) return;
        
        let sheet = workbook.Sheets[sheetName];
        let data = XLSX.utils.sheet_to_json(sheet);
        
        if (data.length === 0) return;

        // Check for new columns
        const firstRow = data[0];
        const hasMediaType = '媒体类型' in firstRow;
        const hasIsDownloaded = '是否下载' in firstRow;
        const hasLocalPath = '本地地址' in firstRow;

        if (!hasMediaType || !hasIsDownloaded || !hasLocalPath) {
            log("检测到缺失列，正在初始化...");
            
            data = data.map(row => {
                if (!('媒体类型' in row)) row['媒体类型'] = '视频'; // Default to Video for old data
                if (!('是否下载' in row)) row['是否下载'] = 1;      // Default to Downloaded (skip) for old data
                if (!('本地地址' in row)) row['本地地址'] = '';
                return row;
            });

            const newSheet = XLSX.utils.json_to_sheet(data, { 
                header: ['编号', '标题', '媒体类型', '分类', '链接', '保存日期', '是否下载', '本地地址'] 
            });
            workbook.Sheets[sheetName] = newSheet;
            XLSX.writeFile(workbook, EXCEL_PATH);
            log(`已为${data.length}条老数据设置默认值`);
            log("初始化完成");
        }
    } catch (e) {
        errorLog("Excel初始化失败", e);
    }
}

function getExcelData() {
    if (!fs.existsSync(EXCEL_PATH)) {
        return [];
    }
    try {
        const workbook = XLSX.readFile(EXCEL_PATH);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        return XLSX.utils.sheet_to_json(sheet);
    } catch (e) {
        errorLog("读取Excel文件失败", e);
        return [];
    }
}

function saveExcelData(newData) {
    let workbook;
    let existingData = [];
    
    try {
        if (fs.existsSync(EXCEL_PATH)) {
            workbook = XLSX.readFile(EXCEL_PATH);
            const sheetName = workbook.SheetNames[0];
            if (sheetName) {
                existingData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
            }
        } else {
            workbook = XLSX.utils.book_new();
        }

        let nextId = 1;
        if (existingData.length > 0) {
            const ids = existingData.map(row => {
                const id = parseInt(row['编号']);
                return isNaN(id) ? 0 : id;
            });
            nextId = Math.max(...ids) + 1;
        }

        const finalData = newData.map((item, index) => ({
            '编号': nextId + index,
            '标题': item.title,
            '媒体类型': item.type,
            '分类': item.category,
            '链接': item.link,
            '保存日期': new Date().toISOString().split('T')[0],
            '是否下载': 0, // New items default to not downloaded
            '本地地址': ''
        }));

        const allData = existingData.concat(finalData);
        // Ensure correct column order
        const sheetWithHeader = XLSX.utils.json_to_sheet(allData, { 
            header: ['编号', '标题', '媒体类型', '分类', '链接', '保存日期', '是否下载', '本地地址'] 
        });

        if (workbook.SheetNames.length === 0) {
            XLSX.utils.book_append_sheet(workbook, sheetWithHeader, "Favorites");
        } else {
            workbook.Sheets[workbook.SheetNames[0]] = sheetWithHeader;
        }

        XLSX.writeFile(workbook, EXCEL_PATH);
        return finalData.length;
    } catch (e) {
        errorLog("保存Excel文件失败", e);
        throw e;
    }
}

function cleanTitle(t) {
    if (!t) return '';
    
    // Remove hashtags (content categories)
    t = t.replace(/#[\w\u4e00-\u9fa5]+/g, '').trim();
    
    t = t.trim();
    if (t.length > 5) {
        const half = Math.floor(t.length / 2);
        const parts = t.split(' ');
        if (parts.length === 2 && parts[0] === parts[1]) {
            return parts[0];
        }
        const first = t.substring(0, half).trim();
        const second = t.substring(t.length - half).trim();
        if (first === second) {
            return first;
        }
    }
    return t;
}

// Auto Scroll Function
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            let distance = 100;
            let timer = setInterval(() => {
                let scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                // Scroll about 2-3 screens or until end
                if(totalHeight >= 3000 || totalHeight >= scrollHeight){
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });
}

(async () => {
    // 1. Initialize Excel Columns if needed
    initializeExcel();

    log("开始抓取今日头条收藏列表");
    const browser = await puppeteer.launch({
        headless: HEADLESS,
        userDataDir: path.join(__dirname, 'user_data'),
        defaultViewport: null,
        args: ['--start-maximized']
    });

    const page = await browser.newPage();

    try {
        log("正在访问今日头条首页...");
        await page.goto('https://www.toutiao.com/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

        log("等待个人中心入口加载...");
        const userLinkSelector = 'a[href*="/c/user/"]';
        
        try {
            await page.waitForSelector(userLinkSelector, { timeout: 15000 });
        } catch (e) {
            log("未找到个人中心入口。请在浏览器中手动登录...");
            await page.waitForSelector(userLinkSelector, { timeout: 60000 });
        }

        const userLinkEl = await page.$(userLinkSelector);
        if (!userLinkEl) throw new Error("无法找到个人中心链接");
        
        const userHref = await page.evaluate(el => el.href, userLinkEl);
        log(`进入个人中心: ${userHref}`);
        
        await page.goto(userHref, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

        log("正在寻找'收藏'标签...");
        await new Promise(r => setTimeout(r, 1000)); 

        let clicked = await page.evaluate(() => {
            const xpaths = [
                "//div[contains(text(), '收藏')]",
                "//span[contains(text(), '收藏')]",
                "//li[contains(text(), '收藏')]",
                "//a[contains(text(), '收藏')]"
            ];
            
            for (const xpath of xpaths) {
                const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                const node = result.singleNodeValue;
                if (node && node.offsetParent !== null) {
                    node.click();
                    return true;
                }
            }
            // Fallback: search all text
            const elements = document.querySelectorAll('div, li, span, a');
            for (let el of elements) {
                if (el.innerText && el.innerText.trim() === '收藏') {
                    el.click();
                    return true;
                }
            }
            return false;
        });

        if (!clicked) {
            throw new Error("未找到'收藏'标签，请检查页面结构或登录状态");
        }
        log("已点击收藏标签");

        // Wait and Scroll
        log("等待列表加载并滚动...");
        await new Promise(r => setTimeout(r, 2000));
        await autoScroll(page);
        await new Promise(r => setTimeout(r, 1000));

        log(`正在提取前 ${FETCH_COUNT} 条内容...`);
        
        const items = await page.evaluate((count) => {
            const results = [];
            
            // Try broad selectors for items
            // Looking for blocks that might be cards
            let potentialItems = Array.from(document.querySelectorAll('.feed-card-wrapper, .article-card, .wtt-feed-card, .card-container, div[class*="card"], div[class*="item"], div.profile-article-card-wrapper, div.profile-normal-video-card-wrapper'));
            
            let validItems = potentialItems.filter(el => {
                const link = el.querySelector('a');
                const text = el.innerText;
                // Basic validation: needs a link and some text
                return link && text && text.trim().length > 10;
            });
            
            // Fallback: direct link search if structure is not found
            if (validItems.length < 2) {
                 const links = Array.from(document.querySelectorAll('a'));
                 const contentLinks = links.filter(a => {
                     const href = a.href;
                     const text = a.innerText.trim();
                     return (href.includes('/group/') || href.includes('/item/') || href.includes('/video/') || href.includes('toutiao.com/a') || href.includes('/article/')) &&
                            !href.includes('/user/') && 
                            !href.includes('#comment') && 
                            !href.includes('comment_id=') &&
                            text.length > 5 &&
                            !text.includes('评论') &&
                            !/^\d+$/.test(text); // Filter out pure numbers
                 });
                 
                 const uniqueLinks = new Map();
                 contentLinks.forEach(a => {
                     // Normalize link to remove hash for deduplication
                     const urlNoHash = a.href.split('#')[0];
                     if (!uniqueLinks.has(urlNoHash)) {
                         uniqueLinks.set(urlNoHash, a);
                     }
                 });
                 
                 // Promote links to their containers for better context (title/category extraction)
                 validItems = Array.from(uniqueLinks.values()).map(a => {
                     let container = a;
                     let p = a.parentElement;
                     // Walk up to find a block container
                     for(let i=0; i<3; i++) {
                         if (p && (p.tagName === 'DIV' || p.tagName === 'LI')) {
                             container = p;
                         }
                         p = p ? p.parentElement : null;
                     }
                     return container;
                  });
            }

            for (let i = 0; i < validItems.length && results.length < count; i++) {
                const el = validItems[i];
                
                // Type Detection
                let type = "未知";
                const className = el.className || "";
                if (className.includes("article") || className.includes("profile-article-card-wrapper")) {
                    type = "文章";
                } else if (className.includes("video") || className.includes("profile-normal-video-card-wrapper")) {
                    type = "视频";
                }

                // Title
                let title = '';
                const titleEl = el.querySelector('.title, h2, h3, h4, a[class*="title"]');
                if (titleEl) {
                    title = titleEl.innerText;
                } else {
                    const links = el.querySelectorAll('a');
                    let maxLen = 0;
                    links.forEach(l => {
                        const t = l.innerText.trim();
                        // Avoid comment links or metadata links
                        if (!l.href.includes('#comment') && !t.includes('评论') && t.length > maxLen) {
                            maxLen = t.length;
                            title = t;
                        }
                    });
                    if (!title) title = el.innerText.substring(0, 50);
                }
                
                // Link
                let link = '';
                const linkEl = el.querySelector('a[href*="/group/"], a[href*="/item/"], a[href*="/video/"], a[href*="toutiao.com/a"]');
                if (linkEl && !linkEl.href.includes('#comment')) {
                    link = linkEl.href;
                } else {
                     const anyLinks = Array.from(el.querySelectorAll('a'));
                     // Find first link that is not a comment link
                     const contentLink = anyLinks.find(l => 
                        (l.href.includes('/group/') || l.href.includes('/item/') || l.href.includes('/video/') || l.href.includes('toutiao.com/a') || l.href.includes('/article/')) && 
                        !l.href.includes('#comment') && 
                        !l.href.includes('comment_id=')
                     );
                     if (contentLink) link = contentLink.href;
                }
                
                if (!link || !title) continue;
                if (link.includes('#comment')) continue; // Double check

                // Clean Title immediately to check validity
                const cleanT = title.replace(/#[\w\u4e00-\u9fa5]+/g, '').trim();
                if (cleanT.length < 2 || cleanT.includes('评论') || /^\d+$/.test(cleanT)) continue;

                // Category
                let category = '无分类';
                const text = el.innerText;
                const match = text.match(/#[\w\u4e00-\u9fa5]+/);
                if (match) {
                    category = match[0];
                }
                
                if (!results.some(r => r.link === link)) {
                    results.push({ title, link, category, type });
                }
            }
            return results;
        }, FETCH_COUNT);

        items.forEach(item => {
            item.title = cleanTitle(item.title);
            if (item.title.length > 200) item.title = item.title.substring(0, 197) + '...';
            if (item.category.length > 100) item.category = item.category.substring(0, 97) + '...';
        });
        
        // Duplicate Check and Save
        const existingData = getExcelData();
        const existingLinks = new Set(existingData.map(r => r['链接']));
        const existingTitles = new Set(existingData.map(r => r['标题']));

        const newItems = [];
        let duplicateCount = 0;

        console.log(`\n==== 今日头条收藏列表前${items.length}条 ====`);
        items.forEach((item, index) => {
            item.title = cleanTitle(item.title);
            console.log(`${index + 1}. [${item.type}] ${item.title} ${item.category}`);
            console.log(`链接: ${item.link}`);

            let isDuplicate = false;
            if (ENABLE_DUPLICATE_CHECK) {
                if (existingLinks.has(item.link)) {
                    isDuplicate = true;
                } else if (existingTitles.has(item.title)) {
                    isDuplicate = true;
                }
            }

            if (isDuplicate) {
                duplicateCount++;
            } else {
                newItems.push(item);
                existingLinks.add(item.link);
                existingTitles.add(item.title);
            }
        });

        if (newItems.length > 0) {
            saveExcelData(newItems);
            log(`\n数据已保存到 ${path.basename(EXCEL_PATH)}`);
        } else {
            log("\n没有新数据需要保存。");
        }

        const msg = `共抓取 ${items.length} 条，新增 ${newItems.length} 条，重复 ${duplicateCount} 条`;
        log(msg);
        writeFetchLog(items.length, newItems.length, duplicateCount);

        // Optional: Trigger download if configured
        if (DOWNLOAD_CONFIG.enable_download === true || DOWNLOAD_CONFIG.enable_download === 'true') {
            log("\n检测到下载功能已启用，正在尝试调用下载模块...");
            try {
                // We use require to run it if it's a module, or just spawn it.
                // Since download_content.js is likely a standalone script, spawning is safer to isolate contexts.
                const { spawn } = require('child_process');
                const downloadProcess = spawn('node', ['download_content.js'], { stdio: 'inherit', cwd: __dirname });
                
                downloadProcess.on('close', (code) => {
                    log(`下载模块运行结束，退出码: ${code}`);
                });
            } catch (e) {
                errorLog("启动下载模块失败", e);
            }
        }

    } catch (err) {
        errorLog("运行出错", err);
    } finally {
        log("程序运行结束");
        await browser.close();
    }
})();
