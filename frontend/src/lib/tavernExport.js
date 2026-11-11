import { exportCharacter, exportLorebook, normalizeCharacter, TAVERN_MAX_IMAGE_BYTES } from './tavern.js';
import { saveBrowserFile } from './browserSave.js';

const encoder = new TextEncoder();
const signature = [137,80,78,71,13,10,26,10];
const filename = name => name.replace(/[\\/:*?"<>|]/g, '_').slice(0,100);
const toBase64 = bytes => { let text = ''; for (let i=0;i<bytes.length;i+=8192) text += String.fromCharCode(...bytes.subarray(i,i+8192)); return btoa(text); };
const crcTable = Uint32Array.from({ length:256 }, (_, value) => { for(let i=0;i<8;i++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
const crc32 = bytes => { let value = 0xffffffff; for(const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ value >>> 8; return (value ^ 0xffffffff) >>> 0; };

export function characterForExport(character, session) {
  return normalizeCharacter({ ...character, ...(session ? { scenario: session.scenario ?? character.scenario, loreEntries: session.loreEntries ?? character.loreEntries } : {}) });
}

// Standard PNG tEXt/chara with UTF-8 JSON encoded as base64 (Character Card V2).
export function embedCharacterPng(bytes, character) {
  if (!(bytes instanceof Uint8Array) || !signature.every((byte,i) => bytes[i] === byte) || bytes.length > TAVERN_MAX_IMAGE_BYTES) throw new Error('角色封面不是有效的PNG。');
  const json = encoder.encode(JSON.stringify(exportCharacter(character)));
  if (json.length > 1024*1024) throw new Error('角色资料超过1MB，请精简设定后导出。');
  const payload = encoder.encode(`chara\0${toBase64(json)}`);
  const chunk = new Uint8Array(payload.length+12), view = new DataView(chunk.buffer);
  view.setUint32(0,payload.length); chunk.set(encoder.encode('tEXt'),4); chunk.set(payload,8);
  view.setUint32(chunk.length-4,crc32(chunk.subarray(4,chunk.length-4)));
  const chunks=[bytes.subarray(0,8)]; let offset=8, ended=false, header=false;
  const inputView = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  while(offset+12<=bytes.length) {
    const length=inputView.getUint32(offset), end=offset+12+length;
    if(end>bytes.length) throw new Error('PNG封面数据不完整。');
    const type=new TextDecoder().decode(bytes.subarray(offset+4,offset+8));
    if(!header && (type!=='IHDR' || length!==13)) throw new Error('PNG封面头信息无效。');
    header=true;
    const data=bytes.subarray(offset+8,end-4), separator=data.indexOf(0);
    const oldCard=['tEXt','iTXt','zTXt'].includes(type) && separator>0 && ['chara','ccv3'].includes(new TextDecoder().decode(data.subarray(0,separator)).toLowerCase());
    if(type==='IEND') { if(length!==0 || end!==bytes.length) throw new Error('PNG封面结束信息无效。'); chunks.push(chunk); ended=true; }
    if(!oldCard) chunks.push(bytes.subarray(offset,end));
    offset=end; if(ended) break;
  }
  if(!ended) throw new Error('PNG封面数据不完整。');
  const size=chunks.reduce((sum,part) => sum+part.length,0);
  if(size>TAVERN_MAX_IMAGE_BYTES) throw new Error('导出PNG超过8MB，请缩小角色头像。');
  const output=new Uint8Array(size); let cursor=0;
  for(const part of chunks) { output.set(part,cursor); cursor+=part.length; }
  return output;
}

async function coverPng(character) {
  const canvas=document.createElement('canvas'); canvas.width=512; canvas.height=768;
  const ctx=canvas.getContext('2d'); if(!ctx) throw new Error('浏览器无法制作PNG角色卡，请使用JSON导出。');
  ctx.fillStyle='#101d30'; ctx.fillRect(0,0,512,768);
  if(character.avatar) {
    let blob;
    if(character.avatar.startsWith('data:')) {
      const [prefix,content]=character.avatar.split(',');
      blob=new Blob([Uint8Array.from(atob(content),char => char.charCodeAt(0))],{ type:prefix.slice(5,prefix.indexOf(';')) });
    } else {
      // normalizeCharacter only permits known same-origin /ai-companions/ paths.
      const response=await fetch(character.avatar,{ credentials:'omit',referrerPolicy:'no-referrer' });
      if(!response.ok) throw new Error('角色头像读取失败，请重试或使用JSON导出。'); blob=await response.blob();
    }
    if(blob.size>TAVERN_MAX_IMAGE_BYTES) throw new Error('角色头像超过8MB。');
    const bitmap=await createImageBitmap(blob);
    try {
      if(!bitmap.width || !bitmap.height || bitmap.width*bitmap.height>40000000) throw new Error('角色头像尺寸过大。');
      const ratio=Math.min(512/bitmap.width,656/bitmap.height), w=bitmap.width*ratio,h=bitmap.height*ratio;
      ctx.drawImage(bitmap,(512-w)/2,(656-h)/2,w,h);
    } finally { bitmap.close(); }
  } else {
    ctx.strokeStyle='#42628c'; ctx.lineWidth=2; ctx.strokeRect(52,62,408,552);
    ctx.fillStyle='#6f97cf'; ctx.font='72px sans-serif'; ctx.textAlign='center'; ctx.fillText(character.name.slice(0,1),256,365);
  }
  ctx.fillStyle='#0b1321'; ctx.fillRect(0,656,512,112);
  ctx.fillStyle='#ecf3ff'; ctx.font='bold 26px sans-serif'; ctx.textAlign='left'; ctx.fillText(character.name,28,705,456);
  ctx.fillStyle='#97afd0'; ctx.font='12px sans-serif'; ctx.fillText('CHARACTER CARD / POSTERFLOW AI',28,738);
  const blob=await new Promise((resolve,reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG封面编码失败。')),'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

export async function downloadTavernExport(character, kind, session) {
  const card=characterForExport(character,session);
  if(kind==='png') return saveBrowserFile(`${filename(card.name)}-角色卡.png`,async () => new Blob([embedCharacterPng(await coverPng(card),card)],{type:'image/png'}));
  if(!['json','lorebook'].includes(kind)) throw new Error('请选择有效的导出格式。');
  const value=kind==='lorebook' ? exportLorebook(card.loreEntries,`${card.name}的世界书`) : exportCharacter(card);
  const json=JSON.stringify(value,null,2);
  if(encoder.encode(json).length>1024*1024) throw new Error('导出资料超过1MB，请精简后重试。');
  return saveBrowserFile(`${filename(card.name)}-${kind==='lorebook' ? '世界书' : '角色卡'}.json`,async () => new Blob([json],{type:'application/json'}));
}
