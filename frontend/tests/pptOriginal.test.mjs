import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getEnv } from 'fabric/node'
import { strToU8, strFromU8, zipSync, unzipSync } from 'fflate'
import { importOriginalPpt, exportOriginalPpt } from '../src/lib/pptOriginal.js'

// Fabric's supported Node environment provides the same XML DOM API as the editor.
const { window } = getEnv()
globalThis.DOMParser = window.DOMParser
globalThis.XMLSerializer = window.XMLSerializer

const p = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const a = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const rels = body => '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + body + '</Relationships>'
const textBody = (title, ns='p') => '<' + ns + ':txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr b="1"/><a:t>' + title + '</a:t></a:r><a:r><a:rPr i="1"/><a:t> suffix</a:t></a:r></a:p></' + ns + ':txBody>'
const xfrm = '<a:xfrm><a:off x="300" y="300"/><a:ext cx="4000" cy="1100"/></a:xfrm>'

function makeDocument() {
  const files = {}, ids = [], references = []
  for (let number=19; number>0; number--) {
    const id = 'rId' + number
    ids.push('<p:sldId id="' + (300+number) + '" r:id="' + id + '"/>')
    references.push('<Relationship Type="' + rel + '/slide" Target="slides/slide' + number + '.xml" Id="' + id + '"/>')
    const table = '<p:graphicFrame><p:xfrm><a:off x="120" y="500"/><a:ext cx="6000" cy="500"/></p:xfrm><a:graphic><a:graphicData><a:tbl><a:tblGrid><a:gridCol w="400"/></a:tblGrid><a:tr h="200"><a:tc>' +
      textBody('Table row','a') + '<a:tcPr/></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
    const chart = '<p:graphicFrame><a:graphic><a:graphicData><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rChart"/></a:graphicData></a:graphic></p:graphicFrame>'
    const pic = '<p:pic><p:blipFill><a:blip r:embed="rImage"/></p:blipFill><p:spPr>' + xfrm + '</p:spPr></p:pic>'
    files['ppt/slides/slide' + number + '.xml'] = strToU8('<p:sld xmlns:p="' + p + '" xmlns:a="' + a + '" xmlns:r="' + rel + '"><p:cSld><p:spTree><p:sp><p:spPr>' +
      xfrm + '</p:spPr>' + textBody('Original ' + number) + '</p:sp>' + table + chart + pic +
      '</p:spTree></p:cSld><p:timing><p:tnLst/></p:timing></p:sld>')
    files['ppt/slides/_rels/slide' + number + '.xml.rels'] = strToU8(rels('<Relationship Type="' + rel + '/image" Target="../media/test.png" Id="rImage"/><Relationship Type="' + rel + '/chart" Target="../charts/chart1.xml" Id="rChart"/>'))
  }
  files['ppt/_rels/presentation.xml.rels'] = strToU8(rels(references.join('')))
  files['ppt/presentation.xml'] = strToU8('<p:presentation xmlns:p="' + p + '" xmlns:r="' + rel + '"><p:sldIdLst>' + ids.join('') + '</p:sldIdLst><p:sldSz cx="8000" cy="6000"/></p:presentation>')
  files['ppt/charts/chart1.xml'] = strToU8('<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>')
  files['ppt/notesSlides/notesSlide2.xml'] = strToU8('<p:notes xmlns:p="' + p + '"/>')
  files['ppt/media/test.png'] = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aZkAAAAASUVORK5CYII=','base64'))
  return files
}

test('an original presentation opens all 19 slides in relation order, at its own aspect ratio, and exports identical source when unedited', async () => {
  const bytes=zipSync(makeDocument()), file = new File([bytes],'小组汇报.pptx')
  const {deck,originalFile} = await importOriginalPpt(file)
  assert.equal(deck.title,'小组汇报')
  assert.equal(deck.slides.length,19)
  assert.equal(deck.originalAspectRatio,4/3)
  assert.equal(deck.slides[0].title,'Original 19 suffix')
  assert.equal(deck.slides[18].title,'Original 1 suffix')
  assert.equal(deck.slides[0].originalTitleId,'t1')
  assert(deck.slides[0].elements.some(e => e.originalLocked && e.text?.includes('图表')))
  assert(deck.slides[0].elements.some(e => e.originalLocked && e.src?.startsWith('data:image/png;base64,')))
  assert.deepEqual(originalFile,{name:file.name,bytes})
  assert.deepEqual(new Uint8Array(await (await exportOriginalPpt(deck,originalFile)).arrayBuffer()),bytes)
  assert.equal(await exportOriginalPpt(deck,file),file)
})

test('only edited parts change, including original table cells, and unchanged formatted runs and timing survive', async () => {
  const input = makeDocument(), file = new File([zipSync(input)],'报告.pptx')
  const {deck} = await importOriginalPpt(file)
  deck.slides[1].elements[0].text = 'New text 🖼 suffix'
  deck.slides[18].elements.find(e => e.originalText?.startsWith('Table row')).text = '1 < 2\n插入一行 & 拓展'
  const blob = await exportOriginalPpt(deck,file)
  const out = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  assert.deepEqual(Object.keys(out).sort(),Object.keys(input).sort())
  for (const name of Object.keys(input)) if (!['ppt/slides/slide18.xml','ppt/slides/slide1.xml'].includes(name)) {
    assert.deepEqual(out[name],input[name],name)
  }
  const xml = new DOMParser().parseFromString(strFromU8(out['ppt/slides/slide18.xml']),'application/xml')
  assert.equal(xml.getElementsByTagNameNS(a,'rPr')[1].getAttribute('i'),'1')
  assert.equal(xml.getElementsByTagNameNS(a,'t')[1].textContent,' suffix')
  assert.equal(xml.getElementsByTagNameNS(p,'timing').length,1)
  const again = await importOriginalPpt(new File([blob],file.name))
  assert.equal(again.deck.slides[1].title,'New text 🖼 suffix')
  assert(again.deck.slides[18].elements.some(e=>e.originalText==='1 < 2\n插入一行 & 拓展'))
})

test('broken slide relationships cannot silently drop a source slide', async () => {
  const parts = makeDocument()
  delete parts['ppt/slides/slide1.xml']
  await assert.rejects(importOriginalPpt(new File([zipSync(parts)],'broken.pptx')), /所有幻灯片/)
})

test('an original shape inherits the theme font color, box alignment and margins while direct run color takes precedence', async () => {
  const parts = makeDocument()
  const key = 'ppt/slides/slide19.xml'
  const styled = strFromU8(parts[key]).replace('</p:spPr><p:txBody>', '</p:spPr><p:style><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style><p:txBody>')
    .replace('<a:bodyPr/>','<a:bodyPr anchor="ctr" lIns="100"/>')
  const attach = (path, type, target) => {
    const previous = parts[path] ? strFromU8(parts[path]) : rels('')
    parts[path] = strToU8(previous.replace('</Relationships>','<Relationship Id="p" Type="' + rel + '/' + type + '" Target="' + target + '"/></Relationships>'))
  }
  attach('ppt/slides/_rels/slide19.xml.rels','slideLayout','../slideLayouts/slideLayout1.xml')
  attach('ppt/slideLayouts/_rels/slideLayout1.xml.rels','slideMaster','../slideMasters/slideMaster1.xml')
  attach('ppt/slideMasters/_rels/slideMaster1.xml.rels','theme','../theme/theme1.xml')
  parts['ppt/slideLayouts/slideLayout1.xml'] = strToU8('<p:sldLayout xmlns:p="'+p+'"/>')
  parts['ppt/slideMasters/slideMaster1.xml'] = strToU8('<p:sldMaster xmlns:p="'+p+'"/>')
  parts['ppt/theme/theme1.xml'] = strToU8('<a:theme xmlns:a="'+a+'"><a:clrScheme><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1></a:clrScheme></a:theme>')
  for (const [xml, color] of [[styled,'#FFFFFF'], [styled.replace('<a:rPr b="1"/>','<a:rPr b="1"><a:solidFill><a:srgbClr val="AB1234"/></a:solidFill></a:rPr>'),'#AB1234']]) {
    parts[key] = strToU8(xml)
    const {deck} = await importOriginalPpt(new File([zipSync(parts)],'theme.pptx'))
    const box = deck.slides[0].elements[0]
    assert.equal(box.color,color)
    assert.equal(box.originalVAlign,'center')
    assert.equal(box.originalInsets.left,16)
  }
})
