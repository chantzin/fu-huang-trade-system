// 輕量級 Markdown 渲染器（支援標題/段落/粗體/斜體/清單/表格/程式碼/連結/分隔線）
import { h } from 'preact';

/** 生成標題 id（slug 化） */
export function slugify(text: any) {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/** 行內格式解析：**粗體**、*斜體*、`程式碼`、[連結](url) */
export function parseInline(text: any, keyPrefix = '') {
  const nodes = [];
  let remaining = text;
  let idx = 0;
    // 圖片 ![alt](url)
    const imgRe = /!\[([^\]]+)\]\(([^)]+)\)/;
    // 連結 [text](url)
    const linkRe = /\[([^\]]+)\]\(([^)]+)\)/;
  // 粗體 **text**
  const boldRe = /\*\*([^*]+)\*\*/;
  // 斜體 *text*（不與粗體重疊）
  const italicRe = /(?<!\*)\*([^*]+)\*(?!\*)/;
  // 行內程式碼 `code`
  const codeRe = /`([^`]+)`/;

  while (remaining.length > 0) {
    const matches = [
      { re: imgRe, type: 'image' },
      { re: linkRe, type: 'link' },
      { re: boldRe, type: 'bold' },
      { re: codeRe, type: 'code' },
      { re: italicRe, type: 'italic' },
    ].map((m: any) => ({ ...m, pos: remaining.search(m.re) })).filter((m: any) => m.pos >= 0);

    if (matches.length === 0) {
      nodes.push(h('span', { key: keyPrefix + '-t-' + idx }, remaining));
      break;
    }
    matches.sort((a: any, b: any) => a.pos - b.pos);
    const first = matches[0];
    if (first.pos > 0) {
      nodes.push(h('span', { key: keyPrefix + '-t-' + idx }, remaining.slice(0, first.pos)));
      idx++;
    }
    const m = remaining.match(first.re);
    if (first.type === 'link') {
      nodes.push(h('a', { key: keyPrefix + '-a-' + idx, href: m[2], target: '_blank', rel: 'noopener' }, m[1]));
    } else if (first.type === 'image') {
      nodes.push(h('img', { key: keyPrefix + '-img-' + idx, src: m[2], alt: m[1], style: 'max-width:100%;height:auto;border:1px solid #E4E7EB;border-radius:8px;margin:10px 0;display:block' }));
    } else if (first.type === 'bold') {
      nodes.push(h('b', { key: keyPrefix + '-b-' + idx }, m[1]));
    } else if (first.type === 'code') {
      nodes.push(h('code', { key: keyPrefix + '-c-' + idx, style: 'background:#F4F6F8;padding:1px 5px;border-radius:3px;font-size:12.5px' }, m[1]));
    } else if (first.type === 'italic') {
      nodes.push(h('i', { key: keyPrefix + '-i-' + idx }, m[1]));
    }
    remaining = remaining.slice(first.pos + m[0].length);
    idx++;
  }
  return nodes;
}

export default function Markdown({ source, className = '' }: any) {
  if (!source) return null;
  const lines = source.split('\n');
  const blocks = [];
  let i = 0;
  let blockIdx = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空白行
    if (line.trim() === '') { i++; continue; }

    // 分隔線
    if (/^---+$/.test(line.trim())) {
      blocks.push(h('hr', { key: 'hr-' + blockIdx++, style: 'border:none;border-top:1px solid #E4E7EB;margin:16px 0' }));
      i++; continue;
    }

    // 標題
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const tag = 'h' + Math.min(level + 1, 6); // h1→h2, h2→h3, ...
      const sizes: any = { h2: '20px', h3: '17px', h4: '15px', h5: '14px', h6: '13px' };
      const id = slugify(text);
      blocks.push(h(tag, { key: 'h-' + blockIdx++, id, style: `color:#0F766E;margin:18px 0 8px;font-size:${sizes[tag] || '14px'};font-weight:700;scroll-margin-top:80px` }, parseInline(text, 'h' + blockIdx)));
      i++; continue;
    }

    // 程式碼區塊
    if (line.trim().startsWith('```')) {
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // 跳過結束 ```
      blocks.push(h('pre', { key: 'pre-' + blockIdx++, style: 'background:#F8F9FA;padding:12px;border-radius:6px;overflow-x:auto;font-size:12.5px;line-height:1.5' },
        h('code', null, codeLines.join('\n'))));
      continue;
    }

    // 表格（連續以 | 開頭的行）
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\|[\s\-:|]+\|$/.test(lines[i + 1].trim())) {
      const headerCells = line.split('|').slice(1, -1).map((c: any) => c.trim());
      i += 2; // 跳過表頭和分隔線
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(lines[i].split('|').slice(1, -1).map((c: any) => c.trim()));
        i++;
      }
      blocks.push(h('table', { key: 'tbl-' + blockIdx++, class: 'mini-table', style: 'width:100%;border-collapse:collapse;margin:10px 0;font-size:12.5px' },
        h('thead', null, h('tr', null, headerCells.map((c: any, ci: any) => h('th', { key: ci, style: 'background:#F0F4F8;padding:6px 8px;border:1px solid #DDE3EA;text-align:left;font-weight:600' }, parseInline(c, 'th' + blockIdx + ci))))),
        h('tbody', null, rows.map((row: any, ri: any) => h('tr', { key: ri }, row.map((c: any, ci: any) => h('td', { key: ci, style: 'padding:5px 8px;border:1px solid #E4E7EB' }, parseInline(c, 'td' + blockIdx + ri + ci))))))));
      continue;
    }

    // 無序列表
    if (/^[\s]*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[\s]*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[\s]*[-*+]\s+/, ''));
        i++;
      }
      blocks.push(h('ul', { key: 'ul-' + blockIdx++, style: 'margin:8px 0;padding-left:24px;line-height:1.7' },
        items.map((it: any, ii: any) => h('li', { key: ii }, parseInline(it, 'ul' + blockIdx + ii)))));
      continue;
    }

    // 有序列表
    if (/^[\s]*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[\s]*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[\s]*\d+\.\s+/, ''));
        i++;
      }
      blocks.push(h('ol', { key: 'ol-' + blockIdx++, style: 'margin:8px 0;padding-left:24px;line-height:1.7' },
        items.map((it: any, ii: any) => h('li', { key: ii }, parseInline(it, 'ol' + blockIdx + ii)))));
      continue;
    }

    // 引用
    if (line.trim().startsWith('> ')) {
      const quoteLines = [];
      while (i < lines.length && lines[i].trim().startsWith('> ')) {
        quoteLines.push(lines[i].replace(/^>\s+/, ''));
        i++;
      }
      blocks.push(h('blockquote', { key: 'q-' + blockIdx++, style: 'border-left:3px solid #0F766E;padding:8px 14px;margin:10px 0;background:#F0FDFA;color:#5A6270;font-size:13px' },
        parseInline(quoteLines.join(' '), 'q' + blockIdx)));
      continue;
    }

    // 一般段落（合併連續非空行）
    const paraLines = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6}\s|[-*+]\s|\d+\.\s|```|\||>|---)/.test(lines[i].trim())) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push(h('p', { key: 'p-' + blockIdx++, style: 'margin:8px 0;line-height:1.7;font-size:13.5px' }, parseInline(paraLines.join(' '), 'p' + blockIdx)));
  }

  return h('div', { class: className }, blocks);
}
