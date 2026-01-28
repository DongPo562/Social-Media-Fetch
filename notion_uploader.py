import os
import json
import sys
import argparse
import requests
import time

# Load environment variables (support .env)
def load_env():
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

NOTION_TOKEN = os.environ.get("NOTION_TOKEN")
if not NOTION_TOKEN:
    print(json.dumps({"success": False, "error": "NOTION_TOKEN not found in .env"}))
    sys.exit(1)

HEADERS = {
    "Authorization": f"Bearer {NOTION_TOKEN}",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json"
}

def text_to_blocks(markdown_text):
    """
    Convert simple markdown text to Notion blocks.
    Supports: Headers (#, ##, ###), Bullet lists (-, *), Quotes (>), and Paragraphs.
    """
    blocks = []
    lines = markdown_text.split('\n')
    
    current_code_block = None
    
    for line in lines:
        stripped = line.strip()
        
        # Handle Code Blocks
        if stripped.startswith('```'):
            if current_code_block is None:
                # Start code block
                lang = stripped[3:].strip()
                current_code_block = {"type": "code", "language": lang or "plain text", "content": []}
            else:
                # End code block
                blocks.append({
                    "object": "block",
                    "type": "code",
                    "code": {
                        "rich_text": [{"type": "text", "text": {"content": "\n".join(current_code_block["content"])}}],
                        "language": current_code_block["language"]
                    }
                })
                current_code_block = None
            continue
            
        if current_code_block is not None:
            current_code_block["content"].append(line)
            continue

        if not stripped:
            continue

        # Headers
        if stripped.startswith('# '):
            blocks.append({
                "object": "block",
                "type": "heading_1",
                "heading_1": {"rich_text": [{"type": "text", "text": {"content": stripped[2:]}}]}
            })
        elif stripped.startswith('## '):
            blocks.append({
                "object": "block",
                "type": "heading_2",
                "heading_2": {"rich_text": [{"type": "text", "text": {"content": stripped[3:]}}]}
            })
        elif stripped.startswith('### '):
            blocks.append({
                "object": "block",
                "type": "heading_3",
                "heading_3": {"rich_text": [{"type": "text", "text": {"content": stripped[4:]}}]}
            })
        # Lists
        elif stripped.startswith('- ') or stripped.startswith('* '):
            blocks.append({
                "object": "block",
                "type": "bulleted_list_item",
                "bulleted_list_item": {"rich_text": [{"type": "text", "text": {"content": stripped[2:]}}]}
            })
        # Quotes
        elif stripped.startswith('> '):
            blocks.append({
                "object": "block",
                "type": "quote",
                "quote": {"rich_text": [{"type": "text", "text": {"content": stripped[2:]}}]}
            })
        # Paragraph
        else:
            # Notion has a limit of 2000 chars per text block
            content = line
            if len(content) > 2000:
                content = content[:1997] + "..."
            
            blocks.append({
                "object": "block",
                "type": "paragraph",
                "paragraph": {"rich_text": [{"type": "text", "text": {"content": content}}]}
            })
            
    # Flush remaining code block if any (unclosed)
    if current_code_block is not None:
        blocks.append({
            "object": "block",
            "type": "code",
            "code": {
                "rich_text": [{"type": "text", "text": {"content": "\n".join(current_code_block["content"])}}],
                "language": current_code_block["language"]
            }
        })

    return blocks

def create_database_page(database_id, title, blocks, metadata=None):
    """
    Create a new page in a Notion database.
    
    Args:
        database_id: The ID of the target database
        title: The title of the page (maps to '标题' property)
        blocks: List of Notion block objects for page content
        metadata: Optional dict with 'link', 'date', 'category' for callout
    """
    url = "https://api.notion.com/v1/pages"
    
    # Construct properties matching the database schema
    # Database has: 标题 (title), 状态 (select), 阅读日期 (date)
    properties = {
        "标题": {
            "title": [
                {
                    "text": {
                        "content": title
                    }
                }
            ]
        },
        "状态": {
            "select": {
                "name": "未读"
            }
        }
    }
    
    # Optionally set 阅读日期 if provided
    if metadata and metadata.get('date'):
        properties["阅读日期"] = {
            "date": {
                "start": metadata['date']
            }
        }

    # Add metadata block at the top if provided
    children = []
    if metadata:
        meta_text = []
        if metadata.get('link'):
            meta_text.append(f"🔗 原文链接: {metadata['link']}")
        if metadata.get('date'):
            meta_text.append(f"📅 抓取日期: {metadata['date']}")
        if metadata.get('category'):
            meta_text.append(f"🏷️ 分类: {metadata['category']}")
            
        if meta_text:
            children.append({
                "object": "block",
                "type": "callout",
                "callout": {
                    "rich_text": [{"type": "text", "text": {"content": "\n".join(meta_text)}}],
                    "icon": {"emoji": "ℹ️"}
                }
            })
            children.append({
                 "object": "block",
                 "type": "divider",
                 "divider": {}
            })

    # Add content blocks (Batching: Notion allows max 100 children in create)
    initial_children = children + blocks[:90]
    remaining_blocks = blocks[90:]
    
    payload = {
        "parent": {"database_id": database_id},
        "properties": properties,
        "children": initial_children,
        "icon": {"emoji": "📄"}
    }
    
    try:
        response = requests.post(url, headers=HEADERS, json=payload)
        response.raise_for_status()
        page_data = response.json()
        page_id = page_data['id']
        page_url = page_data['url']
        
        # Append remaining blocks
        if remaining_blocks:
            append_children(page_id, remaining_blocks)
            
        return {"success": True, "page_id": page_id, "url": page_url}
        
    except requests.exceptions.RequestException as e:
        error_msg = str(e)
        if hasattr(e, 'response') and e.response is not None:
             error_msg += f" Response: {e.response.text}"
        return {"success": False, "error": error_msg}

def append_children(block_id, blocks):
    url = f"https://api.notion.com/v1/blocks/{block_id}/children"
    
    # Batch in groups of 100
    batch_size = 100
    for i in range(0, len(blocks), batch_size):
        batch = blocks[i:i+batch_size]
        payload = {"children": batch}
        try:
            response = requests.patch(url, headers=HEADERS, json=payload)
            response.raise_for_status()
            time.sleep(0.4) # Rate limit mitigation
        except Exception as e:
            print(f"Warning: Failed to append batch {i}: {e}", file=sys.stderr)

def main():
    parser = argparse.ArgumentParser(description='Upload content to Notion Database')
    parser.add_argument('--input', required=True, help='Path to JSON input file')
    args = parser.parse_args()
    
    if not os.path.exists(args.input):
        print(json.dumps({"success": False, "error": f"Input file not found: {args.input}"}))
        sys.exit(1)
        
    try:
        with open(args.input, 'r', encoding='utf-8') as f:
            data = json.load(f)
            
        database_id = data.get('database_id')
        title = data.get('title')
        content = data.get('markdown_content', '')
        metadata = {
            'link': data.get('original_link'),
            'date': data.get('publish_date'),
            'category': data.get('category')
        }
        
        if not database_id or not title:
            print(json.dumps({"success": False, "error": "Missing database_id or title"}))
            sys.exit(1)
            
        blocks = text_to_blocks(content)
        result = create_database_page(database_id, title, blocks, metadata)
        print(json.dumps(result))
        
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()