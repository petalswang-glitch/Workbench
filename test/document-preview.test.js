import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { renderDocxPreviewHtml } from '../src/document-preview.js';

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const source = Buffer.from(value, 'utf8');
    const compressed = deflateRawSync(source);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    locals.push(Buffer.concat([local, compressed]));

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);
    offset += local.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>我的简历</w:t></w:r></w:p>
    <w:p><w:r><w:t>工程师 &amp; 研究员</w:t><w:br/><w:t>第二行</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>公司</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>职位</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>示例 &lt;公司&gt;</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>产品工程</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body>
</w:document>`;

test('DOCX 预览会渲染标题、换行、表格并转义文档文字', () => {
  const html = renderDocxPreviewHtml(makeZip({ 'word/document.xml': documentXml }), '我的简历.docx');

  assert.match(html, /class="docx-preview"/);
  assert.match(html, /<h1[^>]*>.*我的简历/s);
  assert.match(html, /<strong>我的简历<\/strong>/);
  assert.match(html, /工程师 &amp; 研究员/);
  assert.match(html, /第二行/);
  assert.match(html, /<table[\s\S]*<td[\s\S]*公司[\s\S]*<\/table>/);
  assert.match(html, /示例 &lt;公司&gt;/);
  assert.doesNotMatch(html, /<script|onerror\s*=/i);
});

test('缺少 Word 主文档时返回安全的可读降级页', () => {
  const html = renderDocxPreviewHtml(makeZip({ '[Content_Types].xml': '<Types/>' }), '损坏文件.docx');

  assert.match(html, /暂时无法读取文档内容/);
  assert.match(html, /损坏文件\.docx/);
  assert.doesNotMatch(html, /<script|onerror\s*=/i);
});
