import { pptSlideOrder, pptSlideStyles, readOffice, relationships } from './pptFiles.js'
import { nativeMotionState, nativeShapeProperties, applySlideMotion, hasMotion } from './pptMotionExport.js'

const MIB = 1024 * 1024
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const typePptx = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const kids = (el, key) => Array.from(el?.children || []).filter(node => node.localName === key)
const child = (el, key) => kids(el, key)[0]
const first = (el, key) => el?.getElementsByTagNameNS('*', key)[0]
const attr = (el, key) => el?.getAttribute(key)
const number = (el, key) => Number(attr(el, key)) || 0

function paragraphText(p) {
  return Array.from(p.children, part => {
    if (part.localName === 'br') return '\n'
    if (part.localName === 'tab') return '\t'
    return child(part, 't')?.textContent || ''
  }).join('')
}

// Enumerate only the same DrawingML bodies that we can safely write back.
// Dynamic fields, equations and alternate representations remain in the source.
function editableBodies(tree) {
  const result = new Map()
  for (const body of tree.getElementsByTagNameNS('*', 'txBody')) {
    if (!['sp', 'tc'].includes(body.parentElement.localName)) continue
    let parent = body.parentElement
    while (parent && parent !== tree && parent.localName !== 'AlternateContent') parent = parent.parentElement
    if (parent !== tree) continue
    const ps = kids(body, 'p')
    if (!ps.length || ps.some(p => Array.from(p.children).some(n =>
      n.namespaceURI !== A || !['r', 'br', 'tab', 'pPr', 'endParaRPr'].includes(n.localName)))) continue
    const text = ps.map(paragraphText).join('\n')
    if (!text.trim() && body.parentElement.localName !== 'tc' && !first(body.parentElement,'ph')) continue
    const placeholder = attr(first(body.parentElement, 'ph'), 'type')
    if (['dt','ftr','sldNum','hdr'].includes(placeholder)) continue
    result.set(body, { id: 't' + (result.size + 1), originalText: text, text })
  }
  return result
}

function screenBox(xfrm, transform) {
  const off = child(xfrm, 'off'), ext = child(xfrm, 'ext')
  if (!off || !ext) return null
  return { x: transform.x + number(off, 'x') * transform.sx, y: transform.y + number(off, 'y') * transform.sy,
    w: Math.max(1, number(ext, 'cx') * transform.sx), h: Math.max(1, number(ext, 'cy') * transform.sy) }
}

function groupSpace(xfrm, transform) {
  const box = screenBox(xfrm, transform), ext = child(xfrm, 'chExt'), off = child(xfrm, 'chOff')
  if (!box || !number(ext, 'cx') || !number(ext,'cy')) return transform
  const sx = box.w / number(ext, 'cx'), sy = box.h / number(ext, 'cy')
  return { sx, sy, x: box.x - number(off,'x') * sx, y: box.y - number(off,'y') * sy }
}

function pictureSources(office, parts) {
  const relations = new Map()
  const paths = new Set()
  for (const part of parts) {
    const ids = new Map(relationships(office,part).filter(rel => rel.type === 'image' && /^ppt\/media\/[^/]+$/i.test(rel.path))
      .map(rel => [rel.id, rel.path]))
    for (const path of ids.values()) paths.add(path)
    relations.set(part, ids)
  }
  const files = office.pictures(paths), urls = new Map()
  return (part, blip) => {
    const path = relations.get(part)?.get(blip?.getAttributeNS(R, 'embed'))
    if (!files[path]) return null
    if (!urls.has(path)) {
      const bytes = files[path]
      const mime = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 ? 'image/png'
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : null
      if (mime) {
        const chunks = []
        for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)))
        urls.set(path, 'data:' + mime + ';base64,' + btoa(chunks.join('')))
      } else urls.set(path, null)
    }
    return urls.get(path)
  }
}

function slidePreview(context, part, index, aspect, transform, picture) {
  const { slide, layout, master, style, layoutName, masterName, layoutSlots, masterSlots } = context
  const tree = first(slide, 'spTree'), editable = editableBodies(tree), elements = []
  let titleId
  const locked = item => elements.push({id:'p' + (elements.length + 1), originalLocked:true, ...item})
  function label(box, text) {
    locked({ ...box, type:'text', text, color:'#42536A', fill:'#E6EBF1', fontSize:16 })
  }
  function addText(body, box, fill, styles, isTitle, cell = false) {
    const record = editable.get(body)
    const text = record?.text ?? kids(body,'p').map(paragraphText).join('\n')
    if (!record && !text.trim()) {
      if (fill) locked({type:'rect', ...box, fill})
      return
    }
    const p = child(body,'p'), props = child(p,'pPr'), lvl = 'lvl' + (number(props,'lvl') + 1) + 'pPr'
    const ps = [props, ...styles.map(el => child(first(el,'lstStyle'),lvl)), child(first(master, isTitle ? 'titleStyle' : 'bodyStyle'),lvl)]
    const runs = [first(p,'rPr'), ...ps.map(pr => child(pr,'defRPr'))]
    const val = key => runs.map(el => attr(el,key)).find(v => v != null)
    const fontRef = styles.map(shape => child(child(shape,'style'),'fontRef')).find(Boolean)
    const own = [first(p,'rPr'),child(props,'defRPr'),child(child(first(body,'lstStyle'),lvl),'defRPr')]
    const inheritedColor = style.fill(runs.map(pr => child(pr,'solidFill')).find(Boolean), style.color('tx1','#182235'))
    const color = style.fill(own.map(pr => child(pr,'solidFill')).find(Boolean),style.fill(fontRef,inheritedColor))
    const bodyStyles = [child(body,'bodyPr'), ...styles.slice(1).map(el => first(el,'bodyPr'))]
    const cellStyle = cell ? child(body?.parentElement,'tcPr') : null
    const inset = (key, cellKey, fallback, scale) => {
      const v = attr(cellStyle,cellKey) ?? bodyStyles.map(pr => attr(pr,key)).find(value => value != null)
      return (v == null ? fallback : Number(v)) * scale
    }
    const originalInsets = { left:inset('lIns','marL',91440,transform.sx), right:inset('rIns','marR',91440,transform.sx),
      top:inset('tIns','marT',45720,transform.sy), bottom:inset('bIns','marB',45720,transform.sy) }
    const anchor = attr(cellStyle,'anchor') ?? bodyStyles.map(pr => attr(pr,'anchor')).find(Boolean)
    const originalVAlign = ({ctr:'center', b:'bottom'})[anchor] || 'top'
    const align = {ctr:'center',r:'right',l:'left'}[ps.map(pr => attr(pr,'algn')).find(Boolean)]
    const fontSize = Number(val('sz')) * 127 * transform.sy || (isTitle ? 44 : cell ? 16 : 24)
    const item = {type:'text', ...box, text, ...(fill && {fill}), fontSize:Math.max(1, Math.min(360,fontSize)),
      color, originalInsets, originalVAlign, bold: ['1','true'].includes(val('b')), ...(align && {align})}
    if (record) {
      elements.push({...item,...record})
      if (isTitle && !titleId && record.text.trim()) titleId = record.id
    } else locked(item)
  }
  function tableCells(table, box) {
    const cols = kids(child(table,'tblGrid'),'gridCol').map(el => number(el,'w'))
    const rows = kids(table,'tr'), totalW = cols.reduce((sum,v) => sum+v,0), totalH = rows.reduce((sum,r) => sum + number(r,'h'),0)
    if (!totalW || !totalH) { label(box,'表格 · 导出保留原对象'); return }
    let y = box.y
    rows.forEach((row, ri) => {
      const h = box.h * number(row,'h') / totalH
      let x = box.x
      kids(row,'tc').forEach((cell, ci) => {
        const w = box.w * (cols[ci] || 0) / totalW
        if (!['1','true'].includes(attr(cell,'hMerge')) && !['1','true'].includes(attr(cell,'vMerge'))) {
          const span = Math.max(1, number(cell,'gridSpan')), rowSpan = Math.max(1, number(cell,'rowSpan'))
          const mergedW = box.w * cols.slice(ci,ci + span).reduce((s,n) => s+n,0) / totalW
          const mergedH = box.h * rows.slice(ri,ri + rowSpan).reduce((s,r) => s+number(r,'h'),0) / totalH
          const fill = style.fill(child(child(cell,'tcPr'),'solidFill'), ri % 2 ? '#EEF2F5' : '#E1E8EF')
          addText(child(cell,'txBody'),{ x, y, w:mergedW, h:mergedH },fill,[],false,true)
        }
        x += w
      })
      y += h
    })
  }
  function drawShape(shape, space, source, backdrop) {
    const kind = shape.localName
    if (kind === 'grpSp') { draw(shape, groupSpace(child(child(shape,'grpSpPr'),'xfrm'),space), source, backdrop); return }
    if (['nvGrpSpPr','grpSpPr','extLst'].includes(kind)) return
    const ph = first(shape,'ph')
    if (backdrop && ph) return
    const slot = ph && layoutSlots.get(attr(ph,'idx') || '0'), role = attr(slot && first(slot,'ph'),'type') || attr(ph,'type')
    const title = ['title','ctrTitle'].includes(role)
    const parent = ph && masterSlots.get(title ? 'title' : role === 'obj' || role === 'subTitle' || !role ? 'body' : role)
    const styles = [shape,slot,parent].filter(Boolean)
    const xf = styles.map(el => child(child(el,'spPr'),'xfrm') || child(el,'xfrm')).find(t => child(t,'off') && child(t,'ext'))
    const box = screenBox(xf,space) || {x:70,y:title ? 32 : 130, w:1130,h:title ? 72 : 400}
    if (kind === 'pic') {
      const src = picture(source, first(shape,'blip'))
      if (src) locked({type:'image',...box,src})
      else label(box,'图片或媒体 · 导出保留原对象')
    } else if (kind === 'graphicFrame') {
      const tbl = first(shape,'tbl')
      if (tbl) tableCells(tbl,box)
      else label(box, (first(shape,'chart') ? '图表' : first(shape,'relIds') ? 'SmartArt' : '嵌入对象') + ' · 导出保留原对象')
    } else if (kind === 'sp' || kind === 'cxnSp') {
      const pr = child(shape,'spPr'), solid = child(pr,'solidFill')
      const ref = child(child(shape,'style'),'fillRef')
      const fill = child(pr,'noFill') ? undefined : style.fill(solid, number(ref,'idx') ? style.fill(ref) : undefined)
      const body = child(shape,'txBody')
      if (body) addText(body,box,fill,styles,title)
      else if (fill) locked({type:'rect',...box,fill})
    } else label(box,'特殊对象 · 导出保留原对象')
  }
  function draw(group, space, source, backdrop = false) {
    for (const shape of group?.children || []) {
      const firstIndex = elements.length
      drawShape(shape, space, source, backdrop)
      if (group !== tree || backdrop || elements.length === firstIndex) continue
      const props = nativeShapeProperties(shape)
      if (!props) continue
      const type = shapeType(shape)
      for (let i = firstIndex; i < elements.length; i++) {
        elements[i].motionTargetId = 'native-' + props.getAttribute('id')
        elements[i].motionTargetType = type
      }
    }
  }
  const layers = [[master,masterName],[layout,layoutName],[slide,part]]
  let background = style.color('bg1','#FFFFFF'), lastBackground
  for (const [doc, name] of layers) {
    const bg = child(first(doc,'cSld'),'bg')
    background = style.background(doc,background)
    if (bg) lastBackground = [name, first(bg,'blip')]
  }
  const bgImage = lastBackground && picture(...lastBackground)
  if (bgImage) locked({type:'image',x:0,y:0,w:1280,h:720,src:bgImage})
  if (!['0','false'].includes(attr(slide.documentElement,'showMasterSp'))) {
    if (!['0','false'].includes(attr(layout?.documentElement,'showMasterSp'))) draw(first(master,'spTree'),transform,masterName,true)
    draw(first(layout,'spTree'),transform,layoutName,true)
  }
  draw(tree,transform,part)
  if (!titleId) titleId = elements.find(el => el.originalText?.trim())?.id
  const title = elements.find(el => el.id === titleId)?.text.trim().split('\n')[0].slice(0,240) || '第 ' + (index+1) + ' 页'
  return {id:'original-' + (index+1), title, originalTitleId:titleId, originalAspectRatio:aspect, background, elements, ...nativeMotionState(slide)}
}

function shapeType(shape) {
  if (shape.localName === 'grpSp') return 'group'
  if (first(shape,'videoFile') || first(shape,'audioFile') || first(shape,'media')) return 'media'
  if (shape.localName === 'pic') return 'image'
  if (first(shape,'tbl')) return 'table'
  if (first(shape,'chart')) return 'chart'
  return first(shape,'txBody') ? 'text' : 'shape'
}

export async function importOriginalPpt(file) {
  if (!file?.size || file.size > 24*MIB || !/\.pptx$/i.test(file.name)) throw new Error('请选择 24 MB 以内的 .pptx 原稿。')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const office = readOffice(bytes, {original:true})
  const order = pptSlideOrder(office,true), styles = pptSlideStyles(office,order)
  const contexts = order.map(styles)
  if (contexts.some(ctx => !first(ctx.slide,'spTree'))) throw new Error('部分幻灯片缺少页面内容，无法完整打开此原稿。')
  const parts = new Set([...order,...contexts.flatMap(c => [c.layoutName,c.masterName]).filter(Boolean)])
  const picture = pictureSources(office,parts)
  const sz = first(office.xml('ppt/presentation.xml'),'sldSz')
  const width = number(sz,'cx') || 12192000, height = number(sz,'cy') || 6858000
  const aspect = width/height, transform = {x:0,y:0,sx:1280/width,sy:720/height}
  // Some WebKit releases cannot persist a user-selected File in IndexedDB.
  return {originalFile:{name:file.name,bytes}, deck:{title:file.name.replace(/\.pptx$/i,''), originalAspectRatio:aspect,
    slides: order.map((part,i) => slidePreview(contexts[i],part,i,aspect,transform,picture))}}
}

export async function ensureOriginalMotionMetadata(deck, source) {
  if (deck.slides.every(s => typeof s.nativeTiming === 'boolean' && typeof s.nativeTransition === 'boolean')) return deck
  const file = ArrayBuffer.isView(source?.bytes) ? new File([source.bytes],source.name) : source
  const {deck: fresh} = await importOriginalPpt(file)
  if (deck.slides.length !== fresh.slides.length) throw new Error('原稿的页数发生了变化，无法核对动效对象。')
  return {...deck, slides:deck.slides.map((page,i) => {
    const from = fresh.slides[i]
    if (page.id !== from.id) throw new Error('原稿的页面顺序发生了变化，无法核对动效对象。')
    const targets = new Map(from.elements.filter(el => el.motionTargetId).map(el => [el.id,el]))
    return {...page,nativeTiming:from.nativeTiming,nativeTransition:from.nativeTransition,elements:page.elements.map(el => {
      const origin = targets.get(el.id)
      return origin ? {...el,motionTargetId:origin.motionTargetId,motionTargetType:origin.motionTargetType} : el
    })}
  })}
}

function newRun(p, copyStyle) {
  const run = p.ownerDocument.createElementNS(A,'a:r')
  if (copyStyle) run.append(copyStyle.cloneNode(true))
  run.append(p.ownerDocument.createElementNS(A,'a:t'))
  p.insertBefore(run, child(p,'endParaRPr') || null)
  return run
}

// Keep the leading/trailing unchanged runs (including their formatting and links).
// Put the replacement in the run where the edit starts. Never replace a whole shape.
function replaceParagraph(p, value) {
  const previous = paragraphText(p)
  if (value === previous) return
  const before = Array.from(previous), after = Array.from(value)
  let prefix = 0, suffix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  while (suffix < before.length-prefix && suffix < after.length-prefix && before[before.length-1-suffix] === after[after.length-1-suffix]) suffix++
  const insert = after.slice(prefix, after.length-suffix).join('')
  const runs = Array.from(p.children).filter(n => ['r','br','tab'].includes(n.localName))
  let cursor = 0, placed = false
  for (const run of runs) {
    const t = child(run,'t')
    const chars = Array.from(run.localName === 'r' ? (t?.textContent || '') : run.localName === 'br' ? '\n' : '\t')
    const end = cursor + chars.length
    const place = !placed && end >= prefix && (cursor === prefix || end > prefix || prefix === before.length)
    const replacement = chars.slice(0,Math.max(0,prefix-cursor)).join('') + (place ? insert : '') +
      chars.slice(Math.max(0,before.length-suffix-cursor)).join('')
    if (run.localName === 'r') {
      const text = t || p.ownerDocument.createElementNS(A,'a:t')
      if (!t) run.append(text)
      if (text.textContent !== replacement) text.textContent = replacement
    } else if (replacement !== chars.join('')) {
      if (replacement) {
        const r = newRun(p)
        child(r,'t').textContent = replacement
        run.replaceWith(r)
      } else run.remove()
    }
    placed ||= place
    cursor = end
  }
  if (!placed && insert) child(newRun(p),'t').textContent = insert
}

function writeBody(body, value) {
  const ps = kids(body,'p')
  const original = ps.map(paragraphText)
  // A soft break within an original paragraph should survive unrelated edits.
  // Match the intact paragraphs at either end before allocating changed lines.
  let remaining = value, left = 0, right = ps.length
  while (left < right && remaining.startsWith(original[left] + '\n')) {
    remaining = remaining.slice(original[left++].length + 1)
  }
  while (left < right && remaining.endsWith('\n' + original[right-1])) {
    remaining = remaining.slice(0,remaining.length - original[--right].length - 1)
  }
  const lines = remaining.split('\n'), sample = ps[left] || ps[right-1] || ps[0]
  const from = child(sample,'pPr'), to = child(sample,'endParaRPr'), style = first(sample,'rPr')
  const after = ps[right] || null
  lines.forEach((line,i) => {
    let p = ps[left+i]
    if (left+i >= right) {
      p = body.ownerDocument.createElementNS(A,'a:p')
      if (from) p.append(from.cloneNode(true))
      if (to) p.append(to.cloneNode(true))
      newRun(p,style)
      body.insertBefore(p,after)
    }
    replaceParagraph(p,line)
  })
  ps.slice(left+lines.length,right).forEach(p => p.remove())
}

export async function exportOriginalPpt(deck, source, motionEnabled = false) {
  const changes = deck.slides.map(s => s.elements.filter(el => typeof el.originalText === 'string' && el.text !== el.originalText))
  const storedBytes = ArrayBuffer.isView(source.bytes) ? source.bytes : null
  const unchanged = () => storedBytes ? new Blob([storedBytes],{type:typePptx}) : source
  if (!changes.some(row => row.length) && !(motionEnabled && deck.slides.some(s => hasMotion(s.motion)))) return unchanged()
  const bytes = storedBytes || new Uint8Array(await source.arrayBuffer())
  const office = readOffice(bytes,{original:true}), order = pptSlideOrder(office,true)
  if (deck.slides.length !== order.length || deck.slides.some((s,i) => s.id !== 'original-' + (i+1))) {
    throw new Error('原稿的页面顺序发生了变化，无法写回原文件。')
  }
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(bytes), serializer = new XMLSerializer()
  let modified = false
  changes.forEach((edits,i) => {
    const page = deck.slides[i]
    if (!edits.length && !(motionEnabled && hasMotion(page.motion))) return
    const doc = office.xml(order[i]), mapped = new Map()
    const animated = motionEnabled && applySlideMotion(doc,page,true)
    if (!edits.length && !animated) return
    modified = true
    for (const [body, origin] of editableBodies(first(doc,'spTree'))) mapped.set(origin.id, {body,origin})
    for (const item of edits) {
      const entry = mapped.get(item.id)
      if (!entry || entry.origin.originalText !== item.originalText || typeof item.text !== 'string') {
        throw new Error('第 ' + (i+1) + ' 页的文字与导入时不一致，无法写回。')
      }
      if (Array.from(item.text).some(c => c < ' ' && !['\t','\n','\r'].includes(c))) throw new Error('文本包含 PowerPoint 不支持的控制字符。')
      writeBody(entry.body,item.text.replace(/\r\n?/g,'\n'))
    }
    const part = zip.file(order[i])
    zip.file(order[i],serializer.serializeToString(doc),{createFolders:false, date:part.date,
      comment:part.comment, unixPermissions:part.unixPermissions, dosPermissions:part.dosPermissions})
  })
  return modified ? zip.generateAsync({ type:'blob', mimeType:typePptx, compression:'DEFLATE', compressionOptions:{level:3} }) : unchanged()
}
