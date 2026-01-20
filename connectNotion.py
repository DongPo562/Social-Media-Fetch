import requests
import json
from datetime import datetime

import os

def load_env():
    """Load environment variables from .env file"""
    env_path = os.path.join(os.path.dirname(__file__), '.env')
    if os.path.exists(env_path):
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if '=' in line:
                    key, value = line.split('=', 1)
                    os.environ[key.strip()] = value.strip().strip('"').strip("'")

load_env()

# 页面配置
NOTION_TOKEN = os.environ.get("NOTION_TOKEN")
PAGE_ID = os.environ.get("PAGE_ID")  # ← 这就是您的页面ID

if not NOTION_TOKEN or not PAGE_ID:
    print("❌ 错误: 未找到 Notion 配置信息。请确保 .env 文件中包含 NOTION_TOKEN 和 PAGE_ID")
    exit(1)
                      

# API 请求头
headers = {
    "Authorization": f"Bearer {NOTION_TOKEN}",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json"
}

def test_read_page():
    """测试读取页面"""
    print("=" * 50)
    print("测试 1: 读取页面信息")
    print("=" * 50)
    
    url = f"https://api.notion.com/v1/pages/{PAGE_ID}"
    response = requests.get(url, headers=headers)
    
    if response.status_code == 200:
        print("✅ 成功读取页面!")
        data = response.json()
        print(f"页面ID: {data.get('id')}")
        print(f"创建时间: {data.get('created_time')}")
        print(f"最后编辑: {data.get('last_edited_time')}")
        return True
    else:
        print(f"❌ 读取失败: {response.status_code}")
        print(f"错误信息: {response.text}")
        return False

def test_read_blocks():
    """测试读取页面内容块"""
    print("\n" + "=" * 50)
    print("测试 2: 读取页面内容块")
    print("=" * 50)
    
    url = f"https://api.notion.com/v1/blocks/{PAGE_ID}/children"
    response = requests.get(url, headers=headers)
    
    if response.status_code == 200:
        print("✅ 成功读取页面内容!")
        blocks = response.json().get('results', [])
        print(f"页面共有 {len(blocks)} 个内容块")
        for i, block in enumerate(blocks[:3], 1):
            print(f"  块 {i}: {block.get('type')}")
        return True
    else:
        print(f"❌ 读取失败: {response.status_code}")
        print(f"错误信息: {response.text}")
        return False

def test_append_block():
    """测试添加内容块（编辑权限测试）"""
    print("\n" + "=" * 50)
    print("测试 3: 添加测试内容（编辑权限测试）")
    print("=" * 50)
    
    url = f"https://api.notion.com/v1/blocks/{PAGE_ID}/children"
    
    # 创建一个测试块
    test_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    data = {
        "children": [
            {
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [
                        {
                            "type": "text",
                            "text": {
                                "content": f"🧪 自动化测试 - 测试时间: {test_time}"
                            }
                        }
                    ]
                }
            }
        ]
    }
    
    response = requests.patch(url, headers=headers, json=data)
    
    if response.status_code == 200:
        print("✅ 成功添加测试内容!")
        print(f"添加时间: {test_time}")
        return True
    else:
        print(f"❌ 添加失败: {response.status_code}")
        print(f"错误信息: {response.text}")
        return False

def main():
    """运行所有测试"""
    print("\n🚀 开始测试 Notion 页面权限")
    print(f"📄 页面: social media info")
    print(f"🔑 页面ID: {PAGE_ID}\n")
    
    results = {
        "读取页面": test_read_page(),
        "读取内容": test_read_blocks(),
        "编辑页面": test_append_block()
    }
    
    print("\n" + "=" * 50)
    print("📊 测试结果汇总")
    print("=" * 50)
    
    for test_name, result in results.items():
        status = "✅ 通过" if result else "❌ 失败"
        print(f"{test_name}: {status}")
    
    all_passed = all(results.values())
    print("\n" + "=" * 50)
    if all_passed:
        print("🎉 所有测试通过! 页面权限配置正确!")
    else:
        print("⚠️ 部分测试失败，请检查:")
        print("   1. API Token 是否正确")
        print("   2. Integration 是否已连接到该页面")
        print("   3. 页面是否设置为'任何人可编辑'")
    print("=" * 50)

if __name__ == "__main__":
    main()