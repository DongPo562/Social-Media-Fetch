const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const ini = require('ini');
const ExcelUtils = require('./excel_utils');
const axios = require('axios');
const { exec } = require('child_process');

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
const AUDIO_CONFIG = config.Audio || {};

const ENABLE_DOWNLOAD = DOWNLOAD_CONFIG.enable_download !== false;
const ARTICLES_FOLDER = path.resolve(__dirname, DOWNLOAD_CONFIG.articles_folder || 'articles');
const VIDEOS_FOLDER = path.resolve(__dirname, DOWNLOAD_CONFIG.videos_folder || 'videos');
const MAX_VIDEO_SIZE_MB = parseInt(DOWNLOAD_CONFIG.max_video_size || 500);
const DOWNLOAD_TIMEOUT = parseInt(DOWNLOAD_CONFIG.download_timeout || 600000);
const PAGE_LOAD_TIMEOUT = parseInt(DOWNLOAD_CONFIG.page_load_timeout || 30000);
const RETRY_TIMES = parseInt(DOWNLOAD_CONFIG.retry_times || 1);
const RETRY_FAILED = DOWNLOAD_CONFIG.retry_failed === true || DOWNLOAD_CONFIG.retry_failed === 'true';

const ENABLE_AUDIO_EXTRACT = AUDIO_CONFIG.enable_audio_extract === true || AUDIO_CONFIG.enable_audio_extract === 'true';
const AUDIO_BITRATE = parseInt(AUDIO_CONFIG.audio_bitrate || 192);
const KEEP_ORIGINAL_VIDEO = AUDIO_CONFIG.keep_original_video !== false;

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

async function getExcelData() {
    try {
        return await ExcelUtils.readExcelData(EXCEL_PATH);
    } catch (e) {
        errorLog("读取Excel失败", e);
        return [];
    }
}

async function updateExcelStatus(link, status, localPath, errorMsg = '') {
    try {
        const updates = {
            '是否下载': status,
            '本地地址': localPath || errorMsg
        };
        await ExcelUtils.updateExcelRow(EXCEL_PATH, '链接', link, updates);
    } catch (e) {
        errorLog("更新状态失败", e);
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
        let contentEl = null;
        const isWeitoutiao = window.location.href.includes('/w/');

        if (isWeitoutiao) {
             // Micro headline specific selectors
             contentEl = document.querySelector('.weitoutiao-html') || 
                         document.querySelector('div[class*="wtt-content"]');
        } else {
             // Standard article selectors
             contentEl = document.querySelector('article') || 
                         document.querySelector('.article-content') || 
                         document.querySelector('.tt-article-content'); // Toutiao specific class often used
        }
        
        // Fallback: finding the container with most text paragraphs
        // For Weitoutiao, we skip this heuristic fallback to ensure accurate error reporting
        if (!contentEl && !isWeitoutiao) {
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

// Helper for downloading streams
async function downloadStream(url, filePath, maxSizeMB = 0) {
    try {
        const head = await axios.head(url);
        const size = parseInt(head.headers['content-length'] || 0);
        const sizeMB = size / (1024 * 1024);
        if (maxSizeMB > 0 && sizeMB > maxSizeMB) {
            throw new Error(`资源大小 (${sizeMB.toFixed(2)}MB) 超过限制 (${maxSizeMB}MB)`);
        }
    } catch (e) {
        if (e.message.includes('超过限制')) throw e;
    }

    const writer = fs.createWriteStream(filePath);
    const response = await axios({
        url: url,
        method: 'GET',
        responseType: 'stream',
        timeout: DOWNLOAD_TIMEOUT
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', (err) => {
            fs.unlink(filePath, () => {});
            reject(new Error(`下载流失败: ${err.message}`));
        });
    });
}

// Helper for merging video and audio
function mergeStreams(videoPath, audioPath, outputPath) {
    return new Promise((resolve, reject) => {
        // -c:v copy -c:a copy is fastest and lossless
        const cmd = `ffmpeg -i "${videoPath}" -i "${audioPath}" -c:v copy -c:a copy "${outputPath}" -y`;
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`FFmpeg合并失败: ${error.message}`));
            } else {
                resolve();
            }
        });
    });
}

// Helper to check file streams using ffmpeg
function checkFileStreams(filePath) {
    return new Promise((resolve) => {
        const cmd = `ffmpeg -i "${filePath}"`;
        exec(cmd, (error, stdout, stderr) => {
            // FFmpeg output is usually in stderr
            const output = stderr || stdout || '';
            const hasVideo = output.includes('Video:');
            const hasAudio = output.includes('Audio:');
            resolve({ hasVideo, hasAudio });
        });
    });
}

async function downloadVideo(page, item) {
    log(`[视频] 正在处理: ${item['标题']}`);

    const dateStr = item['保存日期'] || new Date().toISOString().split('T')[0];
    const targetDir = path.join(VIDEOS_FOLDER, dateStr);
    ensureDir(targetDir);
    const fileName = `${item['编号']}.mp4`;
    const filePath = path.join(targetDir, fileName);

    // Candidates
    const candidates = [];
    
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');
    
    const responseHandler = (event) => {
        const resp = event.response;
        if (!resp.mimeType) return;
        
        if (resp.url.startsWith('http')) {
            const isVideo = resp.mimeType.includes('video/');
            const isAudio = resp.mimeType.includes('audio/');
            
            if (isVideo || isAudio) {
                candidates.push({
                    url: resp.url,
                    mime: resp.mimeType,
                    type: isVideo ? 'video' : 'audio',
                    length: parseInt(resp.headers['content-length'] || 0)
                });
            }
        }
    };
    client.on('Network.responseReceived', responseHandler);

    try {
        await page.goto(item['链接'], { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT });
    } catch (e) {
        throw new Error(`页面加载失败: ${e.message}`);
    }

    try {
        await page.waitForSelector('video', { timeout: 15000 });
    } catch (e) {
        log("警告: 未找到video标签，等待网络请求捕获...");
    }

    // Wait longer for requests to be captured (10s as requested)
    log("等待媒体流捕获 (10秒)...");
    await new Promise(r => setTimeout(r, 10000));

    // Remove duplicates
    const uniqueCandidates = [];
    const seenUrls = new Set();
    for (const cand of candidates) {
        if (!seenUrls.has(cand.url)) {
            seenUrls.add(cand.url);
            uniqueCandidates.push(cand);
        }
    }

    // Analyze candidates
    log(`捕获到 ${uniqueCandidates.length} 个媒体流请求`);
    let videoUrl = null;
    let audioUrl = null;
    let maxVideoSize = -1;

    for (const cand of uniqueCandidates) {
        log(`  - [${cand.type}] ${cand.mime} Size:${cand.length} URL:${cand.url.substring(0, 50)}...`);
        
        if (cand.type === 'video') {
            // Heuristic: Audio streams sometimes are labeled as video/mp4 but have "audio" in URL
            // Or just multiple video streams, pick largest if length known, otherwise update
            // For now, if we already have a videoUrl, only replace if this one looks "better" (e.g. larger)
            // But often length is 0 for chunks.
            
            // Simple logic: If URL contains 'audio' and we have another option, skip it
            if (cand.url.includes('audio') && !cand.url.includes('video')) {
                 // Likely audio disguised as video mime
                 if (!audioUrl) audioUrl = cand.url;
                 continue;
            }

            // If we don't have a video url yet, take it
            if (!videoUrl) {
                videoUrl = cand.url;
                maxVideoSize = cand.length;
            } else {
                // If we have one, update if this one is larger (and strictly larger than 0)
                if (cand.length > maxVideoSize) {
                    videoUrl = cand.url;
                    maxVideoSize = cand.length;
                }
            }
        } else if (cand.type === 'audio') {
            if (!audioUrl) audioUrl = cand.url;
        }
    }

    // Fallback: If no videoUrl found from network, try DOM
    if (!videoUrl) {
        log("未从网络捕获到视频流，尝试从DOM获取...");
        videoUrl = await page.evaluate(() => {
            const v = document.querySelector('video');
            return v ? v.src : null;
        });
        if (videoUrl && !videoUrl.startsWith('http')) videoUrl = null;
    }
    
    // Fallback: Scripts
    if (!videoUrl) {
        const scriptUrl = await page.evaluate(() => {
            const scripts = document.querySelectorAll('script');
            for (const s of scripts) {
                const c = s.innerText;
                if (c.includes('video_url')) {
                    const match = c.match(/"video_url"\s*:\s*"([^"]+)"/);
                    if (match) return JSON.parse(`"${match[1]}"`);
                }
            }
            return null;
        });
        if (scriptUrl) videoUrl = scriptUrl;
    }

    if (!videoUrl || videoUrl.startsWith('blob:')) {
        throw new Error("无法获取有效的视频下载地址");
    }

    // --- Logic for Downloading and Merging ---

    const tempVideo = path.join(targetDir, `${item['编号']}_v_temp.mp4`);
    const tempAudio = path.join(targetDir, `${item['编号']}_a_temp.mp4`);
    let downloadedVideoPath = null;
    let downloadedAudioPath = null;

    // 1. Download "Video"
    log(`下载主视频流: ${videoUrl.substring(0, 50)}...`);
    await downloadStream(videoUrl, tempVideo, MAX_VIDEO_SIZE_MB);
    
    // Verify what we downloaded
    let videoCheck = await checkFileStreams(tempVideo);
    log(`主文件流检查: Video=${videoCheck.hasVideo}, Audio=${videoCheck.hasAudio}`);

    if (videoCheck.hasVideo) {
        downloadedVideoPath = tempVideo;
    } else {
        log("警告: 下载的'视频'文件实际上不包含视频画面 (可能是音频)!");
        if (!audioUrl && videoCheck.hasAudio) {
            log("  -> 将其作为音频源使用");
            // Rename or just use as audio source
            if (fs.existsSync(tempAudio)) fs.unlinkSync(tempAudio);
            fs.renameSync(tempVideo, tempAudio);
            downloadedAudioPath = tempAudio;
            downloadedVideoPath = null;
            videoUrl = null; // We lost our video source
        } else {
            // Garbage or duplicate audio
            fs.unlink(tempVideo, () => {});
            downloadedVideoPath = null;
        }
    }

    // 1.1 If we have video but no audio, check other candidates
    if (downloadedVideoPath && !videoCheck.hasAudio && !audioUrl) {
        log("主视频没有声音，尝试从其他候选流中寻找音频...");
        const otherCandidates = uniqueCandidates.filter(c => c.url !== videoUrl);
        
        for (const cand of otherCandidates) {
            log(`  检查候选流: ${cand.url.substring(0, 50)}...`);
            const tempCand = path.join(targetDir, `${item['编号']}_cand_${Date.now()}.mp4`);
            try {
                // Download a bit or full? Full is safer for now
                await downloadStream(cand.url, tempCand, MAX_VIDEO_SIZE_MB);
                const candCheck = await checkFileStreams(tempCand);
                log(`  候选流检查: Video=${candCheck.hasVideo}, Audio=${candCheck.hasAudio}`);
                
                if (candCheck.hasAudio) {
                    log("  -> 找到音频流！");
                    if (fs.existsSync(tempAudio)) fs.unlinkSync(tempAudio);
                    fs.renameSync(tempCand, tempAudio);
                    downloadedAudioPath = tempAudio;
                    audioUrl = cand.url; // Mark as found
                    break;
                } else {
                    fs.unlink(tempCand, () => {});
                }
            } catch (e) {
                log(`  候选流下载/检查失败: ${e.message}`);
                if (fs.existsSync(tempCand)) fs.unlink(tempCand, () => {});
            }
        }
    }

    // 2. Download Audio if needed (and not already found in step 1.1)
    if (audioUrl) {
        log(`下载音频流: ${audioUrl.substring(0, 50)}...`);
        try {
            await downloadStream(audioUrl, tempAudio);
            downloadedAudioPath = tempAudio;
        } catch (e) {
            log(`音频下载失败: ${e.message}`);
        }
    }

    // 3. Recovery: If we lost video but have candidates, maybe try another one?
    // (For simplicity, skipping complex retry logic here, but notifying user)
    if (!downloadedVideoPath) {
        throw new Error("未能下载到有效的视频文件 (只有音频或文件无效)");
    }

    // 4. Merge or Rename
    if (downloadedVideoPath && downloadedAudioPath) {
        log("检测到独立的视频和音频文件，开始合并...");
        try {
            await mergeStreams(downloadedVideoPath, downloadedAudioPath, filePath);
            log(`✓ 视频(合并版)已保存: ${filePath}`);
            fs.unlink(downloadedVideoPath, () => {});
            fs.unlink(downloadedAudioPath, () => {});
        } catch (e) {
            log(`合并失败: ${e.message}, 保留主视频文件`);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            fs.renameSync(downloadedVideoPath, filePath);
            if (fs.existsSync(downloadedAudioPath)) fs.unlinkSync(downloadedAudioPath);
        }
    } else if (downloadedVideoPath) {
        if (!videoCheck.hasAudio) {
            log("警告: 视频文件没有声音，且未找到独立音频流。");
        }
        log("仅有视频文件，直接保存...");
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        fs.renameSync(downloadedVideoPath, filePath);
        log(`✓ 视频已保存: ${filePath}`);
    }

    return path.relative(__dirname, filePath);
}

function extractAudio(videoPath, item) {
    return new Promise((resolve, reject) => {
        const fullVideoPath = path.resolve(__dirname, videoPath);
        if (!fs.existsSync(fullVideoPath)) {
            return reject(new Error("Video file not found"));
        }

        const audioPath = fullVideoPath.replace(/\.[^.]+$/, '.mp3');
        // Use ffmpeg to extract audio
        // -vn: no video
        // -ar 44100: audio rate
        // -ac 2: audio channels
        // -b:a: bitrate
        // -y: overwrite
        const cmd = `ffmpeg -i "${fullVideoPath}" -vn -ar 44100 -ac 2 -b:a ${AUDIO_BITRATE}k -f mp3 "${audioPath}" -y`;

        log(`[音频] 开始提取: ${path.basename(audioPath)}`);
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                log(`[音频] 提取失败: ${error.message}`);
                return reject(error);
            }
            log(`✓ [音频] 提取成功: ${audioPath}`);
            
            if (!KEEP_ORIGINAL_VIDEO) {
                fs.unlink(fullVideoPath, (err) => {
                    if (err) log(`警告: 删除原视频失败: ${err.message}`);
                    else log(`原视频已删除`);
                });
            }
            resolve(path.relative(__dirname, audioPath));
        });
    });
}

async function updateExcelAudioStatus(link, status) {
    try {
        const updates = { '音频状态': status };
        await ExcelUtils.updateExcelRow(EXCEL_PATH, '链接', link, updates);
    } catch (e) {
        errorLog("更新音频状态失败", e);
    }
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

    const allData = await getExcelData();
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
                    await updateExcelStatus(item['链接'], 1, "Skipped: Unknown Type");
                    success = true; 
                    continue;
                }
                
                await updateExcelStatus(item['链接'], 1, localPath);
                success = true;
                successCount++;

                // Audio Extraction
                if (item['媒体类型'] === '视频' && ENABLE_AUDIO_EXTRACT) {
                    try {
                        await extractAudio(localPath, item);
                        await updateExcelAudioStatus(item['链接'], '已提取');
                    } catch (ae) {
                        log(`  音频提取失败: ${ae.message}`);
                        await updateExcelAudioStatus(item['链接'], '提取失败');
                    }
                }

            } catch (e) {
                errorMsg = e.message;
                log(`  ✗ 失败: ${errorMsg}`);
                retry++;
                // Wait before retry
                if (retry <= RETRY_TIMES) await new Promise(r => setTimeout(r, 5000));
            }
        }

        if (!success) {
            await updateExcelStatus(item['链接'], 2, '', errorMsg);
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