import { strFromU8, unzipSync } from 'fflate'

const MIB = 1024 * 1024
const TEXT_LIMIT = 12000
const RGB = /^#?([0-9a-f]{6})$/i
const OOXML_PARTS = /^(ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/slide\d+\.xml)|word\/document\.xml|xl\/(sharedStrings\.xml|workbook\.xml|worksheets\/sheet\d+\.xml))$/
const PPT_STYLE_PARTS = /^ppt\/(slides\/_rels|slideLayouts(?:\/_rels)?|slideMasters(?:\/_rels)?|theme)\/[^/]+\.xml(?:\.rels)?$/

// Only inflate document parts needed for text and styles. Never open embedded objects or external relationships.
export function readOffice(bytes, { original = false } = {}) {
  let total = 0
  let entries = 0
  const archiveNames = new Set()
  let archiveSize = 0
  function withinBudget(entry) {
    total += entry.originalSize
    if (entry.originalSize > 8 * MIB || total > 32 * MIB) throw new Error('文档解压后过大，请拆分后导入。')
    return true
  }
  const parts = unzipSync(bytes, { filter(entry) {
    if (++entries > 8000) throw new Error('文档包含过多文件。请选用较小的资料。')
    if (original) {
      if (archiveNames.has(entry.name) || entry.name.includes('\\') || entry.name.startsWith('/') || entry.name.split('/').includes('..')) throw new Error('PPTX 包含无法安全识别的文件路径。')
      archiveNames.add(entry.name)
      archiveSize += entry.originalSize
      if (archiveSize > 256 * MIB) throw new Error('PPTX 解压后过大，请拆分后导入。')
    }
    return OOXML_PARTS.test(entry.name) && withinBudget(entry)
  } })
  const parsed = new Map()
  return { names: Object.keys(parts), pictures(names) {
    return unzipSync(bytes, { filter: entry => names.has(entry.name) && entry.originalSize <= 8 * MIB })
  }, loadStyles(names) {
    const wanted = new Set(names.filter(n => PPT_STYLE_PARTS.test(n) && !Object.hasOwn(parts, n)))
    if (wanted.size) Object.assign(parts, unzipSync(bytes, { filter: entry => wanted.has(entry.name) && withinBudget(entry) }))
  }, xml(name) {
    if (!name || !Object.hasOwn(parts, name)) return null
    if (!parsed.has(name)) {
      const raw = strFromU8(parts[name])
      if (/<!DOCTYPE|<!ENTITY/i.test(raw)) throw new Error('不支持带外部声明的 Office 文档。')
      const doc = new DOMParser().parseFromString(raw, 'application/xml')
      if (doc.getElementsByTagName('parsererror').length) throw new Error('Office 文档格式异常。')
      parsed.set(name, doc)
    }
    return parsed.get(name)
  } }
}

const nodes = (el, name) => Array.from(el?.getElementsByTagNameNS('*', name) || [])
const first = (el, name) => el?.getElementsByTagNameNS('*', name)[0]
const attr = (el, name) => el?.getAttribute(name)
const paragraphs = el => nodes(el, 'p').map(p => Array.from(p.getElementsByTagName('*'))
  .map(n => n.localName === 't' ? n.textContent : n.localName === 'br' || n.localName === 'cr' ? '\n' : n.localName === 'tab' ? '\t' : '').join('')).filter(Boolean)
const hex = (s, fallback) => RGB.exec(s || '')?.[1]?.toUpperCase() || fallback
const themeColor = (el, fallback) => {
  const sys = first(el, 'sysClr')
  const value = hex(attr(first(el, 'srgbClr'), 'val') || attr(sys, 'lastClr'))
  return value ? '#' + value : fallback
}

const child = (el, name) => Array.from(el?.children || []).find(node => node.localName === name)
const relPath = name => name.replace(/\/([^/]+)$/, '/_rels/$1.rels')
export function relationships(office, part) {
  return nodes(office.xml(relPath(part)), 'Relationship').flatMap(rel => {
    const target = attr(rel, 'Target')
    if (!target || attr(rel, 'TargetMode') === 'External' || /[\\?#]|^[a-z]+:|^\/\//i.test(target)) return []
    const path = new URL(target, 'https://document.invalid/' + part).pathname.slice(1)
    return [{ id: attr(rel, 'Id'), type: attr(rel, 'Type')?.split('/').pop(), path }]
  })
}

function sampleParents(office, parts, relation) {
  office.loadStyles(parts.map(relPath))
  const paths = new Map(parts.map(part => [part, relationships(office, part).find(rel => rel.type === relation)?.path]))
  office.loadStyles([...paths.values()].filter(Boolean))
  return paths
}

function themeContext(theme, master, layout, slide) {
  const scheme = first(theme, 'clrScheme')
  const masterMap = first(master, 'clrMap')
  let map = masterMap
  for (const layer of [layout, slide]) {
    const override = first(layer, 'clrMapOvr')
    if (override) map = first(override, 'overrideClrMapping') || masterMap
  }
  const defaults = { bg1:'lt1', bg2:'lt2', tx1:'dk1', tx2:'dk2' }
  function color(key, fallback) {
    if (!key) return fallback
    return themeColor(child(scheme, attr(map, key) || defaults[key] || key), fallback)
  }
  function fill(el, fallback) {
    return themeColor(el, color(attr(first(el, 'schemeClr'), 'val'), fallback))
  }
  function background(layer, fallback) {
    const bg = first(layer, 'bg')
    const ref = child(bg, 'bgRef')
    if (!ref) return fill(bg, fallback)
    const fillStyles = first(theme, 'bgFillStyleLst')
    const style = fillStyles?.children[Number(attr(ref, 'idx')) - 1001]
    return fill(style, fill(ref, fallback))
  }
  const font = first(theme, 'minorFont')
  return { color, fill, background,
    font: attr(nodes(font,'font').find(x => attr(x,'script') === 'Hans'), 'typeface') ||
      attr(first(font,'ea'), 'typeface') || attr(first(font,'latin'), 'typeface') || 'Microsoft YaHei' }
}

const masterType = type => ({ ctrTitle:'title', subTitle:'body', obj:'body', chart:'body', tbl:'body', pic:'body',
  dgm:'body', clipArt:'body', media:'body' })[type] || type
function placeholders(part, key) {
  const result = new Map()
  for (const shape of nodes(part, 'sp')) {
    const ph = first(shape, 'ph')
    if (ph) result.set(attr(ph, key) || (key === 'idx' ? '0' : 'obj'), shape)
  }
  return result
}

export function pptSlideOrder(office, strict = false) {
  const presentation = office.xml('ppt/presentation.xml')
  if (!presentation) throw new Error('文件中没有找到 PowerPoint 演示文稿。')
  const rels = new Map(relationships(office, 'ppt/presentation.xml').filter(rel => rel.type === 'slide').map(rel => [rel.id, rel.path]))
  const order = nodes(presentation, 'sldId').map(s => {
    const id = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
    return rels.get(id || attr(s, 'r:id'))
  })
  if (strict && (!order.length || order.some(name => !office.names.includes(name)) || new Set(order).size !== order.length)) {
    throw new Error('无法按原稿顺序读取所有幻灯片，请在 PowerPoint 中另存为 .pptx 后重试。')
  }
  const valid = order.filter(name => office.names.includes(name))
  const slides = valid.length ? valid : office.names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a,b) => a.localeCompare(b, 'en', { numeric: true }))
  if (!slides.length) throw new Error('演示文稿没有幻灯片。')
  return slides
}

export function pptSlideStyles(office, slides) {
  const layouts = sampleParents(office, slides, 'slideLayout')
  const uniqueParents = map => [...new Set(map.values())].filter(Boolean)
  const masters = sampleParents(office, uniqueParents(layouts), 'slideMaster')
  const themes = sampleParents(office, uniqueParents(masters), 'theme')
  return name => {
    const layoutName = layouts.get(name), masterName = masters.get(layoutName)
    const slide = office.xml(name), layout = office.xml(layoutName), master = office.xml(masterName)
    return { slide, layout, master, layoutName, masterName, style: themeContext(office.xml(themes.get(masterName)), master, layout, slide),
      layoutSlots: placeholders(layout,'idx'), masterSlots: placeholders(master,'type') }
  }
}

function pptParts(office, includeTemplate) {
  const presentation = office.xml('ppt/presentation.xml')
  const slides = pptSlideOrder(office)
  let text = ''
  for (const name of slides) {
    if (text.length >= TEXT_LIMIT) break
    text += paragraphs(office.xml(name)).join('\n') + '\n'
  }
  if (!includeTemplate) return { text }
  const size = first(presentation, 'sldSz')
  const cx = Number(attr(size, 'cx')) || 12192000
  const cy = Number(attr(size, 'cy')) || 6858000
  const sample = slides.slice(0, 6)
  const context = pptSlideStyles(office, sample)
  const template = { slides: [] }
  for (const name of sample) {
    const { slide, layout, master, style, layoutSlots, masterSlots } = context(name)
    const base = style.background(master, style.color('bg1', '#FFFFFF'))
    if (!template.slides.length) Object.assign(template, { font: style.font, accent: style.color('accent1', '#3264DA'), background: base })
    const elements = []
    for (const shape of nodes(slide, 'sp')) {
      if (elements.length === 12) break
      // Slide placeholders match the layout by index; the layout in turn
      // inherits from the master by its placeholder type (not its index).
      const ph = first(shape, 'ph')
      const slot = ph && layoutSlots.get(attr(ph,'idx') || '0')
      const role = attr(first(slot, 'ph'), 'type') || attr(ph, 'type') || 'obj'
      const layers = [shape, slot, ph && masterSlots.get(masterType(role))].filter(Boolean)
      const transforms = layers.map(s => child(child(s, 'spPr'), 'xfrm'))
      const off = transforms.map(t => child(t,'off')).find(Boolean), ext = transforms.map(t => child(t,'ext')).find(Boolean)
      if (!off || !ext) continue
      const copy = paragraphs(shape).join('\n').slice(0,100)
      const fills = layers.map(s => child(child(s,'spPr'), 'solidFill') || child(child(s,'spPr'), 'noFill')).find(Boolean)
      const fill = style.fill(fills)
      const isText = Boolean(copy || (ph && ['title','ctrTitle','subTitle','body','obj','dt','ftr','sldNum'].includes(role)))
      const para = first(first(shape, 'txBody'), 'p')
      const pPr = child(para, 'pPr')
      const level = 'lvl' + (Number(attr(pPr, 'lvl') || 0) + 1) + 'pPr'
      const masterText = !ph ? 'otherStyle' : masterType(role) === 'title' ? 'titleStyle' : 'bodyStyle'
      const paragraphStyles = [pPr, ...layers.map(s => child(first(s, 'lstStyle'), level)), child(first(master, masterText), level)].filter(Boolean)
      const textStyles = [first(para, 'rPr'), ...paragraphStyles.map(p => child(p, 'defRPr'))].filter(Boolean)
      const color = style.fill(textStyles.map(p => child(p, 'solidFill')).find(Boolean))
      const size = Number(textStyles.map(p => attr(p, 'sz')).find(Boolean)) / 75
      const bold = textStyles.map(p => attr(p, 'b')).find(v => v !== null && v !== undefined)
      const align = ({ l:'left', ctr:'center', r:'right' })[paragraphStyles.map(p => attr(p, 'algn')).find(Boolean)]
      elements.push({
        type: isText ? 'text' : 'rect', x: Math.round(Number(attr(off,'x')) * 1280 / cx),
        y: Math.round(Number(attr(off,'y')) * 720 / cy), w: Math.round(Number(attr(ext,'cx')) * 1280 / cx),
        h: Math.round(Number(attr(ext,'cy')) * 720 / cy), ...(copy ? { text: copy } : {}),
        ...(ph && { placeholder: role }), ...(fill && { fill }),
        ...(isText && color && { color }), ...(isText && size > 0 && { fontSize: Math.round(size) }),
        ...(isText && bold != null && { bold: bold === '1' || bold === 'true' }), ...(isText && align && { align }),
      })
    }
    const accent = style.color('accent1', template.accent)
    template.slides.push({ background: style.background(slide, style.background(layout, base)), elements,
      ...(accent !== template.accent && { accent }), ...(style.font !== template.font && { font: style.font }) })
  }
  return { template, text }
}

function workbookText(office) {
  if (!office.xml('xl/workbook.xml')) throw new Error('文件中没有找到电子表格。')
  const shared = nodes(office.xml('xl/sharedStrings.xml'), 'si').map(si => nodes(si, 't').map(t=>t.textContent).join(''))
  const sheets = office.names.filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a,b)=>a.localeCompare(b,'en',{numeric:true}))
  let text = ''
  for (const sheet of sheets) {
    for (const row of nodes(office.xml(sheet), 'row')) {
      const values = nodes(row,'c').map(cell => {
        const type = attr(cell,'t'), value = first(cell,'v')?.textContent || ''
        if (type === 's') return shared[Number(value)] || ''
        if (type === 'inlineStr') return nodes(cell,'t').map(t => t.textContent).join('')
        return value
      })
      text += values.join('\t') + '\n'
      if (text.length >= TEXT_LIMIT) return text
    }
  }
  return text
}

async function pdfText(data) {
  // Both the page and its worker need PDF.js's compatibility build on older browsers.
  const [{ getDocument, GlobalWorkerOptions }, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ])
  GlobalWorkerOptions.workerSrc = worker.default
  const loading = getDocument({ data, isEvalSupported: false, useSystemFonts: false, useWorkerFetch: false })
  try {
    const pdf = await loading.promise
    let text = ''
    for (let i = 1; i <= Math.min(pdf.numPages, 100) && text.length < TEXT_LIMIT; i++) {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      text += content.items.map(t => t.str || '').join(' ') + '\n'
      page.cleanup()
    }
    return text
  } finally { await loading.destroy() }
}

export async function importPptFile(file, kind = 'reference') {
  if (!file || !file.size || file.size > 24 * MIB) throw new Error('请选择 24 MB 以内的非空文件。')
  const ext = file.name.split('.').pop().toLowerCase()
  if (kind === 'template' && ext !== 'pptx') throw new Error('请选择 .pptx 格式的模板。')
  let text, template
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (ext === 'pptx') {
    const parsed = pptParts(readOffice(bytes), kind === 'template')
    text = parsed.text
    if (kind === 'template') template = parsed.template
  } else if (ext === 'docx') {
    text = paragraphs(readOffice(bytes).xml('word/document.xml')).join('\n')
  } else if (ext === 'xlsx') {
    text = workbookText(readOffice(bytes))
  } else if (ext === 'pdf') {
    text = await pdfText(bytes)
  } else if (['txt','md','csv'].includes(ext)) {
    const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le'
      : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8'
    text = new TextDecoder(encoding).decode(bytes)
  } else throw new Error('支持 PPTX、PDF、DOCX、XLSX、TXT、Markdown 和 CSV。')
  text = text.trim()
  if (!text && !template) throw new Error('未提取到可读文本。扫描版 PDF 可先转为可选中文字的文档。')
  return { source: { name: file.name, text: text.slice(0, TEXT_LIMIT) }, ...(template ? {template} : {}) }
}

export async function exportPptFile(deck, savedTemplate, motionEnabled = false) {
  if (!deck?.slides?.length) throw new Error('请先生成幻灯片。')
  const { default: PptxGenJS } = await import('pptxgenjs')
  const pptx = new PptxGenJS()
  // Older projects saved the original template file. New projects store the
  // parsed styles so WebKit never needs to persist a disk-backed File.
  const style = savedTemplate instanceof Blob ? (await importPptFile(savedTemplate, 'template')).template : savedTemplate
  const fontFace = style?.font || 'Microsoft YaHei'
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'PosterFlow AI'
  pptx.title = deck.title
  pptx.theme = { headFontFace: fontFace, bodyFontFace: fontFace, lang: 'zh-CN' }
  for (const page of deck.slides) {
    const slide = pptx.addSlide()
    slide.background = { color: hex(page.background, hex(style?.background, 'FFFFFF')) }
    for (const e of page.elements) {
      const pos = { x: e.x / 96, y: e.y / 96, w: e.w / 96, h: e.h / 96, objectName: e.id }
      if (e.type === 'text') {
        slide.addText(e.text || '', { ...pos, fontFace, fontSize: (e.fontSize || 32) * .75, bold: !!e.bold,
          color: hex(e.color,'141C2B'), align: e.align || 'left', valign: 'top', margin: 0,
          ...(hex(e.fill) && {fill:{color:hex(e.fill)}}), paraSpaceAfter: 0, breakLine: false, lang: 'zh-CN' })
      } else if (e.type === 'rect') {
        const color = hex(e.fill, hex(e.color, '3264DA'))
        slide.addShape(pptx.ShapeType.rect, { ...pos, rectRadius: 0, line: { transparency: 100 }, fill: {color} })
      } else if (e.type === 'image') {
        if (!/^data:image\/(png|jpe?g);base64,/i.test(e.src || '')) throw new Error('页面有图片尚未载入，请补齐图片后再导出。')
        slide.addImage({ ...pos, data:e.src })
      }
    }
  }
  if (motionEnabled && deck.slides.some(slide => slide.motion)) {
    const { addGeneratedMotion } = await import('./pptMotionExport.js')
    return addGeneratedMotion(await pptx.write({outputType:'uint8array',compression:true}),deck.slides)
  }
  return pptx.write({ outputType: 'blob', compression: true })
}
