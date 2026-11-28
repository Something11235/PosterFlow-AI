import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getEnv } from 'fabric/node'
import JSZip from 'jszip'
import { exportPptFile } from '../src/lib/pptFiles.js'
import { importOriginalPpt, exportOriginalPpt, ensureOriginalMotionMetadata } from '../src/lib/pptOriginal.js'
import { applySlideMotion, nativeMotionState } from '../src/lib/pptMotionExport.js'

const {window} = getEnv()
globalThis.DOMParser = window.DOMParser
globalThis.XMLSerializer = window.XMLSerializer
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const parse = xml => new DOMParser().parseFromString(xml,'application/xml')
const nodes = (doc,name) => [...doc.getElementsByTagNameNS(P,name)]
const texts = ['title','method','result','source'].map((id,i) => ({
  type:'text',id,text:id,x:70,y:40 + 120 * i,w:650,h:105,fontSize:35,
}))
const plan = {transition:'fade',groups:[
  {ids:['title','method'],effect:'fade',trigger:'on-click'},
  {ids:['result'],effect:'wipe',trigger:'after-previous'},
  {ids:['source'],effect:'fly',trigger:'on-click'},
]}
const deck = {title:'动效验证',slides:[{id:'s1',title:'方案',elements:texts,motion:plan}]}
const readZip = async blob => JSZip.loadAsync(await blob.arrayBuffer())

test('generated deck exports native entrance rows with simultaneous, sequential and click starts',async () => {
  const staticZip = await readZip(await exportPptFile(deck))
  const animatedZip = await readZip(await exportPptFile(deck,undefined,true))
  const slide = 'ppt/slides/slide1.xml'
  const still = parse(await staticZip.file(slide).async('string'))
  const doc = parse(await animatedZip.file(slide).async('string'))
  assert.deepEqual(nativeMotionState(still),{nativeTiming:false,nativeTransition:false})
  assert.deepEqual(nativeMotionState(doc),{nativeTiming:true,nativeTransition:true})
  assert.equal(nodes(doc,'fade').length,1)
  const rows = nodes(doc,'cTn').filter(n => n.hasAttribute('presetID'))
  assert.deepEqual(rows.map(n => n.getAttribute('nodeType')),['clickEffect','withEffect','afterEffect','clickEffect'])
  assert.deepEqual(rows.map(n => n.getAttribute('presetID')),['10','10','22','2'])
  const names = new Map(nodes(doc,'cNvPr').map(n => [n.getAttribute('id'),n.getAttribute('name')]))
  assert.deepEqual(rows.map(n => names.get(nodes(n,'spTgt')[0].getAttribute('spid'))),texts.map(t => t.id))
  const ids = nodes(doc,'cTn').map(n => n.getAttribute('id'))
  assert.equal(new Set(ids).size,ids.length)
  assert(nodes(still,'spTree')[0].isEqualNode(nodes(doc,'spTree')[0]))
})

test('adds a transition to an empty source transition while preserving slide advance and sound', () => {
  const doc = parse('<p:sld xmlns:p="' + P + '"><p:transition advTm="4700" advClick="0"><p:sndAc><p:endSnd/></p:sndAc></p:transition></p:sld>')
  assert.equal(nativeMotionState(doc).nativeTransition,false)
  assert.equal(applySlideMotion(doc,{motion:{transition:'push',groups:[]}},true),true)
  assert.equal(nativeMotionState(doc).nativeTransition,true)
  const transition = nodes(doc,'transition')[0]
  assert.deepEqual([...transition.children].map(child=>child.localName),['push','sndAc'])
  assert.equal(transition.getAttribute('advTm'),'4700')
  assert.equal(transition.getAttribute('advClick'),'0')
  assert.equal(nodes(doc,'endSnd').length,1)
  assert.equal(applySlideMotion(doc,{motion:{transition:'wipe',groups:[]}},true),false)
})

test('original adds missing layers independently and preserves grouped native targets, older drafts and content',async () => {
  const source = await exportPptFile(deck)
  const zip = await readZip(source)
  const name = 'ppt/slides/slide1.xml'
  let sourceXml = await zip.file(name).async('string')
  sourceXml = sourceXml.replace('</p:spTree>', '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="22" name="原生图组"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="23" name="子对象"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>图组文字</a:t></a:r></a:p></p:txBody></p:sp></p:grpSp></p:spTree>')
  sourceXml = sourceXml.replace('</p:sld>','<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
    '<mc:Fallback><p:transition advTm="3000"><p:split orient="vert"/></p:transition></mc:Fallback></mc:AlternateContent></p:sld>')
  zip.file(name,sourceXml)
  const original = new File([await zip.generateAsync({type:'uint8array'})],'底稿.pptx')
  const {deck: imported,originalFile} = await importOriginalPpt(original)
  const page = imported.slides[0]
  assert.equal(page.nativeTransition,true)
  assert.equal(page.nativeTiming,false)
  const child = page.elements.find(e=>e.text==='图组文字')
  assert.equal(child.motionTargetId,'native-22')
  assert.equal(child.motionTargetType,'group')
  const legacy = structuredClone(imported)
  delete legacy.slides[0].nativeTiming
  const el = legacy.slides[0].elements.find(e=>e.text==='title')
  el.text='修改后的标题'
  delete el.motionTargetId
  const restored = await ensureOriginalMotionMetadata(legacy,originalFile)
  assert.equal(restored.slides[0].elements.find(e=>e.id===el.id).text,el.text)
  assert.equal(restored.slides[0].elements.find(e=>e.id===el.id).motionTargetId,'native-2')
  page.motion = {transition:'wipe',groups:[{effect:'fly',trigger:'after-previous',ids:['native-22']}]}
  const result = await readZip(await exportOriginalPpt(imported,originalFile,true))
  const xml = parse(await result.file(name).async('string')), before = parse(sourceXml)
  assert.deepEqual(nativeMotionState(xml),{nativeTransition:true,nativeTiming:true})
  assert.equal(nodes(xml,'transition').length,1)
  assert(nodes(before,'transition')[0].isEqualNode(nodes(xml,'transition')[0]))
  assert(nodes(before,'spTree')[0].isEqualNode(nodes(xml,'spTree')[0]))
  assert.deepEqual([...new Set(nodes(xml,'spTgt').map(n=>n.getAttribute('spid')))],['22'])
  for(const entry of Object.keys(zip.files)) {
    if(entry!==name && !zip.files[entry].dir) assert.deepEqual(await result.file(entry).async('uint8array'),await zip.file(entry).async('uint8array'),entry)
  }
  assert.equal(applySlideMotion(xml,page,true),false)
  assert.deepEqual(new Uint8Array(await (await exportOriginalPpt(imported,originalFile,false)).arrayBuffer()),originalFile.bytes)
  const withTiming = parse(sourceXml.replace(/<mc:AlternateContent[\s\S]+?<\/mc:AlternateContent>/,'<p:timing><p:tnLst/></p:timing>'))
  assert.equal(applySlideMotion(withTiming,page,true),true)
  assert.equal(nodes(withTiming,'wipe').length,1)
  assert.equal(nodes(withTiming,'timing').length,1)
  assert.equal(nodes(withTiming,'spTgt').length,0)
})
