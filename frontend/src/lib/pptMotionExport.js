/*!
 * PowerPoint timing and entrance presets adapted from PPT Master 6.10.0.
 * Copyright (c) 2025-2026 Hugo He. MIT license, see /licenses/ppt-master.txt.
 */
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main'
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const duration = 400
const presets = {fade:[10,0], wipe:[22,4], fly:[2,4]}

export function nativeShapeProperties(shape) {
  if (shape?.namespaceURI !== P || !['sp','pic','cxnSp','grpSp','graphicFrame'].includes(shape.localName)) return null
  for (const node of shape.children) {
    if (node.namespaceURI !== P || !node.localName.startsWith('nv')) continue
    const props = Array.from(node.children).find(c => c.namespaceURI === P && c.localName === 'cNvPr')
    if (props && /^[1-9]\d*$/.test(props.getAttribute('id'))) return props
  }
  return null
}

// A Morph transition, for example, can be hidden inside mc:AlternateContent.
// Keep the entire original wrapper including any downlevel fallback.
function slideChild(slide, local) {
  return Array.from(slide.children).find(el =>
    (el.namespaceURI === P && el.localName === local) ||
    (el.namespaceURI === MC && el.localName === 'AlternateContent' && el.getElementsByTagNameNS(P,local).length))
}

export function nativeMotionState(doc) {
  return {
    nativeTiming: Boolean(slideChild(doc.documentElement,'timing')),
    nativeTransition: hasTransitionEffect(slideChild(doc.documentElement,'transition')),
  }
}

// Some editors emit an empty transition on every page, or set only its
// advance delay or sound. PowerPoint shows no visual transition in that case.
function hasTransitionEffect(transition) {
  if (!transition) return false
  if (transition.namespaceURI === MC) return true
  return Array.from(transition.children).some(child =>
    child.namespaceURI !== P || !['sndAc','extLst'].includes(child.localName))
}

export function hasMotion(plan) {
  return Boolean(plan && (['fade','push','wipe'].includes(plan.transition) || plan.groups?.length))
}

const condition = delay => '<p:stCondLst><p:cond delay="' + delay + '"/></p:stCondLst>'
const values = (key,val) => '<p:tav tm="' + key + '"><p:val><p:strVal val="' + val + '"/></p:val></p:tav>'

function animationRow(shapeId, effect, trigger, nextId) {
  const [preset,subtype] = presets[effect]
  const row = nextId()
  const target = '<p:tgtEl><p:spTgt spid="' + shapeId + '"/></p:tgtEl>'
  const property = name => '<p:attrNameLst><p:attrName>' + name + '</p:attrName></p:attrNameLst>'
  const show = '<p:set><p:cBhvr><p:cTn id="' + nextId() + '" dur="1" fill="hold">' + condition(0) +
    '</p:cTn>' + target + property('style.visibility') + '</p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>'
  const coordinate = (name,from,to) => '<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base">' +
    '<p:cTn id="' + nextId() + '" dur="' + duration + '" fill="hold"/>' + target + property(name) + '</p:cBhvr>' +
    '<p:tavLst>' + values(0,from) + values(100000,to) + '</p:tavLst></p:anim>'
  const animation = effect === 'fly' ? coordinate('ppt_x','#ppt_x','#ppt_x') + coordinate('ppt_y','1+#ppt_h/2','#ppt_y') :
    '<p:animEffect transition="in" filter="' + (effect === 'wipe' ? 'wipe(down)' : 'fade') + '"><p:cBhvr>' +
    '<p:cTn id="' + nextId() + '" dur="' + duration + '"/>' + target + '</p:cBhvr></p:animEffect>'
  return '<p:par><p:cTn id="' + row + '" presetID="' + preset + '" presetClass="entr" presetSubtype="' + subtype +
    '" fill="hold" grpId="0" nodeType="' + trigger + '">' + condition(0) + '<p:childTnLst>' + show +
    animation + '</p:childTnLst></p:cTn></p:par>'
}

function createTiming(groups, targets) {
  const seen = new Set(), clicks = []
  let id = 2
  const nextId = () => ++id
  for (const group of groups || []) {
    if (!Object.hasOwn(presets,group?.effect) || !['on-click','after-previous'].includes(group.trigger) || !Array.isArray(group.ids)) continue
    const shapeIds = [...new Set(group.ids.map(key => targets.get(key)).filter(shape => shape && !seen.has(shape)))]
    if (!shapeIds.length) continue
    shapeIds.forEach(shape => seen.add(shape))
    if (!clicks.length || group.trigger === 'on-click') {
      clicks.push({id:nextId(), automatic:group.trigger === 'after-previous', beats:[]})
    }
    const click = clicks.at(-1), beatId = nextId()
    const rows = shapeIds.map((shape,i) => animationRow(shape, group.effect,
      i ? 'withEffect' : group.trigger === 'on-click' ? 'clickEffect' : 'afterEffect', nextId))
    click.beats.push('<p:par><p:cTn id="' + beatId + '" fill="hold">' + condition(click.beats.length * duration) +
      '<p:childTnLst>' + rows.join('') + '</p:childTnLst></p:cTn></p:par>')
  }
  if (!clicks.length) return ''
  const steps = clicks.map(click => '<p:par><p:cTn id="' + click.id + '" fill="hold"><p:stCondLst><p:cond delay="indefinite"/>' +
    (click.automatic ? '<p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>' : '') +
    '</p:stCondLst><p:childTnLst>' + click.beats.join('') + '</p:childTnLst></p:cTn></p:par>')
  const nav = (list,event) => '<p:' + list + '><p:cond evt="' + event + '" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:' + list + '>'
  return '<p:timing xmlns:p="' + P + '"><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot">' +
    '<p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>' +
    steps.join('') + '</p:childTnLst></p:cTn>' + nav('prevCondLst','onPrev') + nav('nextCondLst','onNext') +
    '</p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'
}

export function applySlideMotion(doc, page, original = false) {
  if (!hasMotion(page.motion)) return false
  const {transition,groups} = page.motion, slide = doc.documentElement
  const tree = doc.getElementsByTagNameNS(P,'spTree')[0]
  const targets = new Map()
  for (const shape of tree?.children || []) {
    const props = nativeShapeProperties(shape)
    if (!props) continue
    const id = props.getAttribute('id')
    targets.set(original ? 'native-' + id : props.getAttribute('name'), id)
  }
  const insert = (xml,before) => {
    const fragment = new DOMParser().parseFromString(xml,'application/xml').documentElement
    slide.insertBefore(doc.importNode(fragment,true),before || null)
  }
  let changed = false
  let transitionNode = slideChild(slide,'transition')
  if (['fade','push','wipe'].includes(transition) && !hasTransitionEffect(transitionNode)) {
    if (!transitionNode) {
      transitionNode = doc.createElementNS(P,'p:transition')
      slide.insertBefore(transitionNode,slideChild(slide,'timing') || slideChild(slide,'extLst') || null)
    }
    if (!transitionNode.hasAttribute('spd') && !transitionNode.hasAttributeNS(P14,'dur')) {
      transitionNode.setAttribute('spd','fast')
      transitionNode.setAttributeNS(P14,'p14:dur',String(duration))
    }
    const effect = doc.createElementNS(P,'p:' + transition)
    if (transition !== 'fade') effect.setAttribute('dir','l')
    transitionNode.insertBefore(effect,transitionNode.firstElementChild)
    changed = true
  }
  if (groups?.length && !slideChild(slide,'timing')) {
    const timing = createTiming(groups,targets)
    if (timing) { insert(timing,slideChild(slide,'extLst')); changed = true }
  }
  return changed
}

export async function addGeneratedMotion(bytes, slides) {
  const {default:JSZip} = await import('jszip')
  const zip = await JSZip.loadAsync(bytes), serialize = new XMLSerializer()
  for (const [i,page] of slides.entries()) {
    if (!hasMotion(page.motion)) continue
    // PptxGenJS creates consecutive parts in presentation order; source-deck
    // editing uses its actual OOXML slide relationships in exportOriginalPpt.
    const part = 'ppt/slides/slide' + (i + 1) + '.xml'
    const xml = new DOMParser().parseFromString(await zip.file(part).async('string'),'application/xml')
    if (applySlideMotion(xml,page)) zip.file(part,serialize.serializeToString(xml))
  }
  return zip.generateAsync({type:'blob',compression:'DEFLATE',mimeType:'application/vnd.openxmlformats-officedocument.presentationml.presentation'})
}
