// Persist only bounded task metadata per owner. Credentials, attachments,
// signed URLs and image bytes never enter this archive.
export const IMAGE_TASK_LIMIT = 3;
const MAX_TASKS=50, MAX_AGE=7*86400000;
const safeText=(value,max)=>typeof value==='string'?value.slice(0,max):'';
function taskMetadata(value, restore=false) {
  if(!value || typeof value.id!=='string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.id) || !Number.isSafeInteger(value.createdAt) || value.createdAt<=0 || value.createdAt>Date.now()+60000 || value.createdAt<Date.now()-MAX_AGE) return null;
  const images=(Array.isArray(value.images)?value.images:[]).slice(0,4).filter(image=>typeof image?.filename==='string' && /^[A-Za-z0-9_-]{1,180}\.(png|gif|jpe?g|webp)$/i.test(image.filename)).map(image=>({filename:image.filename}));
  const status=restore && value.status==='running'?'pending':['running','completed','failed','pending'].includes(value.status)?value.status:'pending';
  const code=/^[A-Z0-9_]{1,100}$/.test(value.error?.code||'')?value.error.code:'IMAGE_TASK_PENDING';
  return {id:value.id,prompt:safeText(value.prompt,6000),model:safeText(value.model,100),billingMode:value.billingMode==='own_key'?'own_key':'platform',status,active:!restore && value.active===true,createdAt:value.createdAt,images,
    route:['buytoken','apimart','legacy'].includes(value.route)?value.route:'legacy',
    ...(value.backgroundName?{backgroundName:safeText(value.backgroundName,80)}:{}),
    ...(status==='pending'?{error:{code,message:'原任务状态待确认，请查询原任务，不要重新生成。',submission_unknown:true,recovery_confirmed:value.error?.recovery_confirmed===true,billing_mode:value.billingMode==='own_key'?'own_key':'platform'}}:status==='failed'?{error:{code,message:'本次任务未完成，可查看原任务记录。'}}:{})};
}
export function createImageTaskStore(limit = IMAGE_TASK_LIMIT, identity = "guest", options={}) {
  let storage;try{storage=options.storage===undefined?globalThis.localStorage:options.storage;}catch{}
  const key=`posterflow.image-tasks.v2:${identity}`;
  let tasks=[];
  try{const raw=storage?.getItem(key);if(raw && raw.length<=512*1024){const saved=JSON.parse(raw);if(Array.isArray(saved))tasks=saved.map(item=>taskMetadata(item,true)).filter(Boolean).slice(0,MAX_TASKS);}}catch{}
  const listeners = new Set();
  const recovery = new Map();
  const publish = () => { try{storage?.setItem(key,JSON.stringify(tasks.map(item=>taskMetadata(item)).filter(Boolean).slice(0,MAX_TASKS)));}catch{}for (const listener of listeners) listener(); };
  return {
    identity,
    getSnapshot: () => tasks,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    registerRecovery(id, query) { recovery.set(id, query); },
    recover(id) { return recovery.get(id)?.(); },
    importJobs(jobs) {
      for(const job of jobs){const current=tasks.find(item=>item.id===job.id);if(current?.active || current?.status==='completed' && current.images.length && (job.status!=='completed' || !job.images?.length))continue;
        const next=taskMetadata({...job,...(current?.prompt?{prompt:current.prompt}:{}),...(current?.backgroundName?{backgroundName:current.backgroundName}:{})},true);
        if(next)tasks=[...tasks.filter(item=>item.id!==next.id),next];}
      tasks=tasks.sort((a,b)=>b.createdAt-a.createdAt).slice(0,MAX_TASKS);publish();
    },
    start(id, { prompt, model, billingMode, route='legacy',backgroundName }) {
      if (tasks.some(task => task.id === id) || tasks.filter(task => task.active).length >= limit) return false;
      tasks = [{ id, prompt, model, billingMode,route,...(backgroundName?{backgroundName}:{}), status: "running", active: true, createdAt: Date.now(), images: [] }, ...tasks];
      tasks = tasks.filter((task, index) => task.active || index < MAX_TASKS);
      for (const id of recovery.keys()) if (!tasks.some(task => task.id === id)) recovery.delete(id);
      publish(); return true;
    },
    finish(id, { images = [], error = null, pending = false, prompt } = {}) {
      const task = tasks.find(item => item.id === id);
      if (!task || (!task.active && task.status !== "pending")) return;
      tasks = tasks.map(item => item.id !== id ? item : { ...item, active: false,
        status: error ? (pending ? "pending" : "failed") : "completed",
        images, error, prompt: prompt ?? item.prompt });
      publish();
    },
  };
}

export function referenceCapability(spec) {
  const limit = spec?.maxReferences ?? spec?.references ?? 8;
  return { limit, disabled: limit === 0 };
}

// A late successful result must update the selected gallery as well as the list.
// Ignore responses from an old account/store, even after switching back to it.
export function syncImageTaskSelection(store, jobs, { currentStore, currentOwner, selectedId }) {
  if (store !== currentStore || store.identity !== currentOwner) return null;
  const before = getCompletedImageTask(store, selectedId);
  store.importJobs(jobs);
  if (!jobs.some(job => job.id === selectedId)) return null;
  const after = getCompletedImageTask(store, selectedId);
  if (!after || (before && before.images.length === after.images.length
    && before.images.every((image, index) => image.filename === after.images[index].filename))) return null;
  return after;
}

export function getCompletedImageTask(store, requestId) {
  const task = store.getSnapshot().find(item => item.id === requestId);
  return task?.status === "completed" && !task.active && task.images.length ? task : null;
}
