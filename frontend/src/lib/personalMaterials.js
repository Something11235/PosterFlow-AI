const DB='posterflow-ai-personal-materials';
const MAX_BYTES=16*1024*1024,MAX_TOTAL=100*1024*1024;
const request=q=>new Promise((resolve,reject)=>{q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
async function database(){
  const q=indexedDB.open(DB,1);
  q.onupgradeneeded=()=>{for(const name of ['images','groups']){const s=q.result.createObjectStore(name,{keyPath:'id'});s.createIndex('owner','owner');}};
  return request(q);
}
async function access(mode,callback){
  const db=await database(),tx=db.transaction(['images','groups'],mode);
  const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error || new Error('保存没有完成，请重试。'));tx.onerror=()=>reject(tx.error);});
  done.catch(()=>{});
  try{const result=await callback(tx);await done;return result;}
  catch(e){try{tx.abort();}catch{/* Already completed or aborted. */}throw new Error(e?.name==='QuotaExceededError'?'浏览器存储空间不足，请删除部分个人图片后重试。':e?.message || '个人素材读取失败，请重试。');}
  finally{db.close();}
}
export async function personalMaterials(owner){
  return access('readonly',async tx=>{
    const [images,groups]=await Promise.all(['images','groups'].map(s=>request(tx.objectStore(s).index('owner').getAll(owner))));
    return {images:images.sort((a,b)=>a.createdAt-b.createdAt),groups:groups.sort((a,b)=>a.createdAt-b.createdAt)};
  });
}
export async function createMaterialGroup(owner,name,builtinNames){
  name=String(name || '').trim();
  if(!name || name.length>40)throw new Error('分类名称请填写 1–40 个字符。');
  return access('readwrite',async tx=>{
    const store=tx.objectStore('groups'),groups=await request(store.index('owner').getAll(owner));
    if(groups.length>=50)throw new Error('最多创建 50 个个人分类。');
    if([...builtinNames,...groups.map(g=>g.name)].some(n=>n.toLocaleLowerCase()===name.toLocaleLowerCase()))throw new Error('已有同名分类，请换一个名称。');
    const group={id:'personal-group-'+crypto.randomUUID(),name,owner,createdAt:Date.now()};
    await request(store.add(group));return group;
  });
}
export async function preparePersonalImage(file){
  if(!file.size || file.size>MAX_BYTES)throw new Error(`${file.name}：每张图片最多 16 MB。`);
  const bytes=new Uint8Array(await file.arrayBuffer());
  const type=bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff?'image/jpeg':bytes.slice(0,8).join(',')==='137,80,78,71,13,10,26,10'?'image/png':String.fromCharCode(...bytes.slice(0,6)).match(/^GIF8[79]a$/)?'image/gif':String.fromCharCode(...bytes.slice(0,4))==='RIFF' && String.fromCharCode(...bytes.slice(8,12))==='WEBP'?'image/webp':'';
  if(!type)throw new Error(`${file.name}：支持 JPG、PNG、WebP 或 GIF 图片。`);
  const blob=new Blob([file],{type});let bitmap;
  try{bitmap=await createImageBitmap(blob);if(!bitmap.width || !bitmap.height || bitmap.width*bitmap.height>40000000)throw new Error();}
  catch{bitmap?.close();throw new Error(`${file.name}：图片无法读取或像素过大，请更换图片。`);}
  const width=bitmap.width,height=bitmap.height;bitmap.close();
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  return {id:'personal-image-'+crypto.randomUUID(),name:file.name.slice(0,150),label:file.name.slice(0,150),blob,type,width,height,bytes:file.size,sha256:hash,createdAt:Date.now()};
}
export async function addPersonalImages(owner,groupId,files,builtinIds){
  if(!files.length || files.length>20)throw new Error('每次请选择 1–20 张图片。');
  const prepared=[];for(const file of files)prepared.push(await preparePersonalImage(file));
  return access('readwrite',async tx=>{
    const groups=await request(tx.objectStore('groups').index('owner').getAll(owner));
    if(!builtinIds.includes(groupId) && !groups.some(g=>g.id===groupId))throw new Error('分类已变化，请重新选择。');
    const store=tx.objectStore('images'),existing=await request(store.index('owner').getAll(owner));
    const hashes=new Set(existing.filter(i=>i.groupId===groupId).map(i=>i.sha256)),added=[];
    for(const image of prepared){if(hashes.has(image.sha256))continue;hashes.add(image.sha256);added.push({...image,groupId,owner});}
    if(existing.length+added.length>100 || existing.reduce((n,i)=>n+i.bytes,0)+added.reduce((n,i)=>n+i.bytes,0)>MAX_TOTAL)throw new Error('个人素材最多保留 100 张、共 100 MB，请先删除部分图片。');
    for(const image of added)await request(store.add(image));
    return {added,duplicates:prepared.length-added.length};
  });
}
export async function deletePersonalImage(owner,id){
  return access('readwrite',async tx=>{const store=tx.objectStore('images'),image=await request(store.get(id));if(!image || image.owner!==owner)throw new Error('没有找到当前账户的图片。');await request(store.delete(id));});
}
export function personalMaterialFile(image){
  return new File([image.blob],image.name,{type:image.type,lastModified:image.createdAt});
}
