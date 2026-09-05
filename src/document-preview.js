import { zipReader } from './zip-reader.js';

const MAX_DOCUMENT_XML_BYTES = 12 * 1024 * 1024;
const MAX_XML_NODES = 150000;
const MAX_RENDERED_HTML_BYTES = 4 * 1024 * 1024;

function escapeHtml(value = '') {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function decodeXml(value = '') {
  return String(value).replace(/&#x([0-9a-f]+);|&#([0-9]+);|&([a-z]+);/gi, (whole, hex, decimal, named) => {
    if (hex || decimal) {
      const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
      if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '\ufffd';
      return String.fromCodePoint(codePoint);
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[named.toLowerCase()] || whole;
  });
}

function localName(name = '') {
  return String(name).split(':').pop();
}

function parseAttributes(source = '') {
  const attributes = {};
  for (const match of String(source).matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

function parseXml(xml) {
  if (/<!(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('文档 XML 包含不支持的声明');
  const root = { name: '#root', attributes: {}, children: [] };
  const stack = [root];
  let nodeCount = 0;
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[^>]+>|[^<]+/g;
  for (const match of String(xml).matchAll(tokens)) {
    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) {
      stack[stack.length - 1].children.push({ type: 'text', value: token.slice(9, -3) });
      continue;
    }
    if (token.startsWith('</')) {
      const closingName = token.slice(2, -1).trim();
      if (stack.length === 1 || stack[stack.length - 1].name !== closingName) throw new Error('文档 XML 结构无效');
      stack.pop();
      continue;
    }
    if (token.startsWith('<!')) throw new Error('文档 XML 声明无效');
    if (token.startsWith('<')) {
      const selfClosing = /\/\s*>$/.test(token);
      const inner = token.slice(1, selfClosing ? -2 : -1).trim();
      const nameMatch = inner.match(/^([A-Za-z_][\w:.-]*)\b([\s\S]*)$/);
      if (!nameMatch) throw new Error('文档 XML 标签无效');
      const node = { name: nameMatch[1], attributes: parseAttributes(nameMatch[2]), children: [] };
      nodeCount += 1;
      if (nodeCount > MAX_XML_NODES) throw new Error('文档 XML 节点过多');
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
      continue;
    }
    if (token) stack[stack.length - 1].children.push({ type: 'text', value: decodeXml(token) });
  }
  if (stack.length !== 1) throw new Error('文档 XML 未闭合');
  return root;
}

function children(node, name) {
  return (node?.children || []).filter(child => child.type !== 'text' && (!name || localName(child.name) === name));
}

function child(node, name) {
  return children(node, name)[0] || null;
}

function descendant(node, name) {
  if (!node) return null;
  for (const current of children(node)) {
    if (localName(current.name) === name) return current;
    const found = descendant(current, name);
    if (found) return found;
  }
  return null;
}

function attribute(node, name) {
  const entry = Object.entries(node?.attributes || {}).find(([key]) => localName(key) === name);
  return entry?.[1] ?? '';
}

function textContent(node) {
  return (node?.children || []).map(current => current.type === 'text' ? current.value : textContent(current)).join('');
}

function renderInline(node) {
  if (!node || node.type === 'text') return escapeHtml(node?.value || '');
  const name = localName(node.name);
  if (name === 't' || name === 'delText' || name === 'instrText') return escapeHtml(textContent(node));
  if (name === 'tab') return '&#9;';
  if (name === 'br' || name === 'cr') return '<br>';
  if (name === 'noBreakHyphen') return '&#8209;';
  if (name === 'drawing' || name === 'pict' || name === 'object') return '<span class="docx-inline-note">[图片或对象]</span>';
  if (name === 'r') {
    const properties = child(node, 'rPr');
    let rendered = children(node).filter(current => localName(current.name) !== 'rPr').map(renderInline).join('');
    if (child(properties, 'b') && attribute(child(properties, 'b'), 'val') !== '0' && attribute(child(properties, 'b'), 'val') !== 'false') rendered = `<strong>${rendered}</strong>`;
    if (child(properties, 'i') && attribute(child(properties, 'i'), 'val') !== '0' && attribute(child(properties, 'i'), 'val') !== 'false') rendered = `<em>${rendered}</em>`;
    const underline = child(properties, 'u');
    if (underline && attribute(underline, 'val') !== 'none') rendered = `<u>${rendered}</u>`;
    return rendered;
  }
  return children(node).map(renderInline).join('');
}

function paragraphClass(node) {
  const properties = child(node, 'pPr');
  const style = attribute(child(properties, 'pStyle'), 'val').toLowerCase();
  const alignment = attribute(child(properties, 'jc'), 'val').toLowerCase();
  const classes = ['docx-paragraph'];
  if (style === 'title' || style === 'subtitle') classes.push(`docx-${style}`);
  const heading = style.match(/heading([1-6])/);
  if (heading) classes.push(`docx-heading-${heading[1]}`);
  if (['center', 'right', 'both', 'left'].includes(alignment)) classes.push(`docx-align-${alignment}`);
  return classes.join(' ');
}

function renderParagraph(node) {
  const content = children(node).filter(current => localName(current.name) !== 'pPr').map(renderInline).join('');
  const classes = paragraphClass(node);
  const tag = classes.includes('docx-title') ? 'h1' : (classes.match(/docx-heading-([1-6])/) ? `h${Math.min(6, Number(classes.match(/docx-heading-([1-6])/)[1]) + 1)}` : 'p');
  return `<${tag} class="${classes}">${content || '<span class="docx-empty-line">&nbsp;</span>'}</${tag}>`;
}

function renderBlocks(nodes = []) {
  return nodes.flatMap(node => {
    if (!node || node.type === 'text') return [];
    const name = localName(node.name);
    if (name === 'p') return [renderParagraph(node)];
    if (name === 'tbl') return [renderTable(node)];
    if (['sdt', 'sdtContent', 'ins', 'del', 'smartTag'].includes(name)) return renderBlocks(children(node));
    return [];
  }).join('');
}

function renderTable(node) {
  const rows = children(node, 'tr');
  if (!rows.length) return '';
  const body = rows.map(row => {
    const cells = children(row, 'tc');
    return `<tr>${cells.map(cellNode => {
      const properties = child(cellNode, 'tcPr');
      const span = Number.parseInt(attribute(child(properties, 'gridSpan'), 'val'), 10);
      const colspan = Number.isInteger(span) && span > 1 && span <= 12 ? ` colspan="${span}"` : '';
      const content = renderBlocks(children(cellNode).filter(current => localName(current.name) !== 'tcPr')) || '<p class="docx-paragraph"><span class="docx-empty-line">&nbsp;</span></p>';
      return `<td${colspan}>${content}</td>`;
    }).join('')}</tr>`;
  }).join('');
  return `<table class="docx-table"><tbody>${body}</tbody></table>`;
}

function previewShell(originalName, body, notice = '本机快速预览：文字、换行和表格已还原，复杂排版或嵌入对象可能与原文件略有差异。') {
  const safeName = escapeHtml(originalName || '简历文件');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
    :root { color-scheme: light; --ink: #1d2630; --muted: #68727d; --line: #d6dce1; --paper: #fffdf8; --wash: #eef2f5; }
    * { box-sizing: border-box; } body { margin: 0; color: var(--ink); background: var(--wash); font: 15px/1.72 "Segoe UI", "Microsoft YaHei", sans-serif; }
    .docx-preview { width: min(920px, 100%); margin: 0 auto; padding: 20px 16px 40px; }
    .docx-meta { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 12px; color: var(--muted); font: 11px/1.4 "Segoe UI", "Microsoft YaHei", sans-serif; }
    .docx-meta strong { overflow-wrap: anywhere; color: var(--ink); font-size: 13px; font-weight: 600; }
    .docx-paper { min-height: calc(100vh - 100px); padding: clamp(28px, 5vw, 64px) clamp(22px, 7vw, 78px); background: var(--paper); border: 1px solid var(--line); box-shadow: 0 8px 24px rgba(29, 38, 48, .08); }
    .docx-paper > :first-child { margin-top: 0; } .docx-paper > :last-child { margin-bottom: 0; }
    .docx-paragraph { margin: .55em 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .docx-title { margin-top: 0; font-size: clamp(26px, 4vw, 42px); line-height: 1.15; }
    .docx-subtitle { color: var(--muted); font-size: 20px; } .docx-heading-1 { font-size: 26px; } .docx-heading-2 { font-size: 21px; } .docx-heading-3 { font-size: 18px; }
    .docx-heading-1, .docx-heading-2, .docx-heading-3, .docx-heading-4, .docx-heading-5, .docx-heading-6 { margin-top: 1.35em; line-height: 1.3; }
    .docx-align-center { text-align: center; } .docx-align-right { text-align: right; } .docx-align-both { text-align: justify; }
    .docx-table { width: 100%; margin: 18px 0; border-collapse: collapse; table-layout: fixed; }
    .docx-table td { padding: 8px 10px; border: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
    .docx-table .docx-paragraph { margin: 0; } .docx-inline-note { color: var(--muted); font-size: .9em; }
    .docx-note { margin: 12px 2px 0; color: var(--muted); font: 11px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif; }
    @media (max-width: 560px) { .docx-preview { padding: 12px 8px 24px; } .docx-meta { display: block; } .docx-meta strong { display: block; margin-top: 4px; } .docx-paper { padding: 28px 18px; } }
  </style></head><body><main class="docx-preview"><div class="docx-meta"><span>DOCUMENT PREVIEW / 本地预览</span><strong>${safeName}</strong></div><article class="docx-paper">${body}</article><p class="docx-note">${escapeHtml(notice)}</p></main></body></html>`;
}

function fallbackPreview(originalName) {
  return previewShell(originalName, '<div class="docx-paragraph"><strong>暂时无法读取文档内容</strong><br>请下载原文件，或将文件转换为 PDF 后重新上传。</div>', '当前文件格式或内容暂不支持应用内还原；原文件仍可通过下载入口获取。');
}

export function renderDocxPreviewHtml(input, originalName = '简历.docx') {
  try {
    const zip = zipReader(input, { label: 'DOCX', maxEntryBytes: MAX_DOCUMENT_XML_BYTES });
    const documentBytes = zip.read('word/document.xml');
    if (!documentBytes || documentBytes.length > MAX_DOCUMENT_XML_BYTES) return fallbackPreview(originalName);
    const root = parseXml(documentBytes.toString('utf8'));
    const body = descendant(root, 'body');
    const rendered = renderBlocks(children(body));
    if (!rendered || Buffer.byteLength(rendered, 'utf8') > MAX_RENDERED_HTML_BYTES) return fallbackPreview(originalName);
    return previewShell(originalName, rendered);
  } catch {
    return fallbackPreview(originalName);
  }
}
