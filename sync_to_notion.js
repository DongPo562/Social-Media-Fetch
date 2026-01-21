const fs = require('fs');
const path = require('path');
const ini = require('ini');
const ExcelUtils = require('./excel_utils');
const { spawn } = require('child_process');

// Load Config
const configPath = path.join(__dirname, 'config.ini');
let config = {};
try {
    config = ini.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (e) {
    console.error("Config file not found or invalid.");
}

const NOTION_CONFIG = config.Notion || {};
const TOUTIAO_CONFIG = config.TouTiao || {};
const ADVANCED_CONFIG = config.Advanced || {};

const ENABLE_NOTION_SYNC = NOTION_CONFIG.enable_notion_sync === true || NOTION_CONFIG.enable_notion_sync === 'true';
const PARENT_PAGE_ID = NOTION_CONFIG.parent_page_id;
const RETRY_FAILED = NOTION_CONFIG.retry_failed === true || NOTION_CONFIG.retry_failed === 'true';

const EXCEL_PATH = path.resolve(__dirname, TOUTIAO_CONFIG.excel_path || 'favorite.xlsx');
const MARKDOWN_FOLDER = path.join(__dirname, 'articles_markdown');

// Logging Helpers
function log(msg) {
    console.log(msg);
    const logFile = `notion_sync_${new Date().toISOString().split('T')[0].replace(/-/g, '')}.log`;
    try {
        fs.appendFileSync(path.join(__dirname, logFile), `[${new Date().toISOString()}] ${msg}\n`);
    } catch (e) {}
}

function errorLog(msg, error) {
    console.error(msg, error);
    try {
        fs.appendFileSync(path.join(__dirname, 'sync_errors.log'), `[${new Date().toISOString()}] ${msg}\n${error ? error.stack : ''}\n\n`);
    } catch (e) {}
}

// Excel Helpers
async function getExcelData() {
    try {
        return await ExcelUtils.readExcelData(EXCEL_PATH);
    } catch (e) {
        errorLog("读取Excel失败", e);
        return [];
    }
}

async function updateExcelNotionStatus(link, status, notionUrl = '') {
    try {
        const updates = {
            'Notion状态': status
        };
        if (notionUrl) {
            updates['Notion链接'] = notionUrl;
        }
        await ExcelUtils.updateExcelRow(EXCEL_PATH, '链接', link, updates);
    } catch (e) {
        errorLog("更新Excel失败", e);
    }
}

function convertToMarkdown(txtPath, title, link, date, category) {
    try {
        const content = fs.readFileSync(txtPath, 'utf-8');
        
        // Basic cleanup
        let lines = content.split('\n');
        
        // Remove title from content if it's repeated at start (often the case)
        if (lines.length > 0 && lines[0].trim() === title.trim()) {
            lines.shift();
        }
        
        // Filter empty lines and normalize
        let cleanLines = [];
        let lastWasEmpty = false;
        
        for (let line of lines) {
            let trimmed = line.trim();
            if (!trimmed) {
                if (!lastWasEmpty) {
                    cleanLines.push('');
                    lastWasEmpty = true;
                }
            } else {
                // Try to detect headers
                // If line is short and doesn't end with punctuation, might be a header
                if (trimmed.length < 50 && !/[.,;!?。，；！？]$/.test(trimmed)) {
                     // Heuristic: Heading 3 for subsections
                     cleanLines.push(`### ${trimmed}`);
                } else {
                     cleanLines.push(trimmed);
                }
                lastWasEmpty = false;
            }
        }
        
        const body = cleanLines.join('\n');
        
        // Front Matter is for file storage, but we pass raw body to Python script.
        // The Python script adds metadata as a Callout block, so we don't strictly need Front Matter in the body passed to Notion.
        // But for the local MD file, we should add it.
        
        const frontMatter = `---
title: ${title}
link: ${link}
date: ${date}
category: ${category}
---

`;
        return frontMatter + body;
        
    } catch (e) {
        throw new Error(`Markdown转换失败: ${e.message}`);
    }
}

async function syncToNotion(item) {
    const id = item['编号'];
    const title = item['标题'];
    const link = item['链接'];
    const date = item['保存日期'];
    const category = item['分类'];
    const localRelPath = item['本地地址'];

    if (!localRelPath) {
        throw new Error("本地文件路径为空，未下载？");
    }

    const txtPath = path.resolve(__dirname, localRelPath);
    if (!fs.existsSync(txtPath)) {
        throw new Error(`找不到本地文件: ${txtPath}`);
    }

    // Convert
    const mdContentFull = convertToMarkdown(txtPath, title, link, date, category);
    
    // Save MD file
    if (!fs.existsSync(MARKDOWN_FOLDER)) {
        fs.mkdirSync(MARKDOWN_FOLDER, { recursive: true });
    }
    // Handle filename conflicts
    let mdFilename = `${id}_${title.replace(/[\\/:*?"<>|]/g, '_')}.md`;
    if (mdFilename.length > 100) mdFilename = `${id}_article.md`;
    const mdPath = path.join(MARKDOWN_FOLDER, mdFilename);
    fs.writeFileSync(mdPath, mdContentFull, 'utf-8');

    // Prepare JSON for Python
    // We strip FrontMatter for Notion upload because we pass metadata separately
    const mdBody = mdContentFull.replace(/^---\n[\s\S]*?\n---\n\n/, '');
    
    const payload = {
        parent_page_id: PARENT_PAGE_ID,
        title: title,
        markdown_content: mdBody,
        original_link: link,
        publish_date: date,
        category: category
    };
    
    const tempJsonPath = path.join(__dirname, `temp_sync_${id}.json`);
    fs.writeFileSync(tempJsonPath, JSON.stringify(payload), 'utf-8');

    return new Promise((resolve, reject) => {
        const pythonProcess = spawn('python', ['notion_uploader.py', '--input', tempJsonPath]);
        
        let stdoutData = '';
        let stderrData = '';

        pythonProcess.stdout.on('data', (data) => {
            stdoutData += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
            stderrData += data.toString();
        });

        pythonProcess.on('close', (code) => {
            // Cleanup
            try { fs.unlinkSync(tempJsonPath); } catch(e) {}

            if (code !== 0) {
                reject(new Error(`Python script exited with code ${code}: ${stderrData}`));
                return;
            }

            try {
                // Find JSON in output (in case of other prints)
                const lines = stdoutData.split('\n');
                let result = null;
                for (let line of lines) {
                    try {
                        const json = JSON.parse(line);
                        if (json.success !== undefined) {
                            result = json;
                            break;
                        }
                    } catch (e) {}
                }

                if (result && result.success) {
                    resolve(result.url);
                } else {
                    reject(new Error(result ? result.error : "Unknown error parsing Python output"));
                }
            } catch (e) {
                reject(new Error(`Failed to parse Python output: ${e.message}\nOutput: ${stdoutData}`));
            }
        });
    });
}

(async () => {
    if (!ENABLE_NOTION_SYNC) {
        log("Notion同步功能未启用 (config.ini [Notion] enable_notion_sync=false)");
        return;
    }

    if (!PARENT_PAGE_ID) {
        log("错误: 未配置 Notion parent_page_id");
        return;
    }

    log("=========================================");
    log("开始 Notion 同步流程");
    log("=========================================");

    const allData = await getExcelData();
    const tasks = allData.filter(item => {
        if (item['媒体类型'] !== '文章') return false;
        
        // Default undefined status to 0
        const status = item['Notion状态'] !== undefined ? parseInt(item['Notion状态']) : 0;
        
        if (status === 0) return true;
        if (RETRY_FAILED && status === 2) return true;
        return false;
    });

    if (tasks.length === 0) {
        log("没有需要同步的文章。");
        return;
    }

    log(`待同步文章: ${tasks.length} 篇`);

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < tasks.length; i++) {
        const item = tasks[i];
        const indexStr = `[${i + 1}/${tasks.length}]`;
        log(`${indexStr} 正在同步: ${item['标题']}`);

        try {
            // Rate limit delay
            await new Promise(r => setTimeout(r, 500));

            const notionUrl = await syncToNotion(item);
            log(`  ✓ 同步成功!`);
            await updateExcelNotionStatus(item['链接'], 1, notionUrl);
            successCount++;
        } catch (e) {
            log(`  ✗ 失败: ${e.message}`);
            errorLog(`同步失败: ${item['标题']}`, e);
            await updateExcelNotionStatus(item['链接'], 2);
            failCount++;
        }
    }

    log("\n=========================================");
    log("同步任务完成");
    log(`成功: ${successCount}`);
    log(`失败: ${failCount}`);
    log("=========================================");

})();
