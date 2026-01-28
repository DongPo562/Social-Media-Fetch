const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  // 启动浏览器并指定用户数据目录
  console.log('正在启动浏览器...');
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: 'D:\\Auto Workbench\\puppeteer\\user_data', // 关键配置
    args: [
      '--window-size=1920,1080' // 设置浏览器窗口大小为适合屏幕的尺寸
    ],
    defaultViewport: null // 让浏览器使用实际窗口大小作为视口
  });

  const page = await browser.newPage();
  
  // 访问需要登录的网站
  console.log('正在访问网站...');
  await page.goto('https://www.toutiao.com', {
    waitUntil: 'networkidle2',
    timeout: 30000
  });
  
  // 点击右上角"呦呦鹿鸣"
  console.log('正在点击"呦呦鹿鸣"...');
  try {
    // 等待元素加载完成，使用更通用的选择器
    await page.waitForSelector('a', { timeout: 10000 });
    
    // 查找包含"呦呦鹿鸣"文本的链接
    const links = await page.$$('a');
    let found = false;
    
    for (const link of links) {
      const text = await link.evaluate(el => el.textContent);
      if (text && text.includes('呦呦鹿鸣')) {
        await link.click();
        found = true;
        break;
      }
    }
    
    if (!found) {
      throw new Error('未找到"呦呦鹿鸣"链接');
    }
    
    console.log('已点击"呦呦鹿鸣"');
  } catch (error) {
    console.error('点击"呦呦鹿鸣"失败:', error);
    await browser.close();
    return;
  }
  
  // 直接导航到收藏页面
  console.log('正在导航到收藏页面...');
  try {
    await page.goto('https://www.toutiao.com/collection', {
      waitUntil: 'load',
      timeout: 60000
    });
    console.log('已导航到收藏页面');
  } catch (error) {
    console.error('导航到收藏页面失败:', error);
    // 即使失败也继续执行，尝试直接提取标题
  }
  
  // 提取并列出收藏列表中最近5条内容的标题
  console.log('正在提取收藏列表中的标题...');

  try {
    // 提取收藏列表中的标题，使用更灵活的选择器
    const titles = await page.evaluate(() => {
      // 尝试不同的选择器来找到收藏项
      const selectors = [
        '.collection-item',
        '.item',
        '.article-item',
        '.list-item',
        'li'
      ];
      
      let items = [];
      
      // 尝试每种选择器
      for (const selector of selectors) {
        const foundItems = document.querySelectorAll(selector);
        if (foundItems.length > 0) {
          items = Array.from(foundItems);
          break;
        }
      }
      
      const titleList = [];
      
      // 遍历提取标题，最多取5条
      for (let i = 0; i < Math.min(items.length, 5); i++) {
        const item = items[i];
        // 尝试不同的标题选择器
        const titleSelectors = ['h2', 'h3', 'h4', 'a.title', 'a[title]', '.title'];
        let titleText = '';
        
        for (const selector of titleSelectors) {
          const titleElement = item.querySelector(selector);
          if (titleElement) {
            titleText = titleElement.textContent.trim();
            if (titleText) break;
          }
        }
        
        // 如果找到了标题，添加到列表
        if (titleText) {
          titleList.push(titleText);
        }
      }
      
      return titleList;
    });
    
    // 输出最近5条收藏内容的标题
    console.log('收藏列表中最近5条内容的标题:');
    if (titles.length > 0) {
      titles.forEach((title, index) => {
        console.log(`${index + 1}. ${title}`);
      });
    } else {
      console.log('收藏列表为空');
    }
  } catch (error) {
    console.error('提取收藏列表标题失败:', error);
  }
  
  await browser.close();
  console.log('完成!');
})();