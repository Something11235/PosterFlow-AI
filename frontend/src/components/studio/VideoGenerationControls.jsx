import React,{useId} from 'react';
import {SlidersHorizontal} from 'lucide-react';

const sizes=['21:9','16:9','4:3','1:1','3:4','9:16','adaptive'];
export default function VideoGenerationControls({values,onChange,newer,final,source,ratioReason,autoVideo=false}){
  const wan=values.model==='wan3.0-video';
  const h3Max=values.model==='MiniMax-H3-Max',h3=h3Max || values.model==='MiniMax-H3';
  const standard=values.model==='seedance-2.0';
  const fast=values.model==='seedance-2.0-fast';
  const id=useId(),duration=final?source?.requested_duration || -1:Number(values.duration),max=newer||wan?30:15,min=wan?2:h3Max?5:4;
  const locked=final || autoVideo || newer && values.omni_reference_task_type==='edit';
  const auto=duration===-1;
  function setDuration(value){const n=Number(value);if(Number.isInteger(n) && n>=min && n<=max)onChange({duration:n});}
  return <section className="video-generation-controls video-composer-card" aria-label="视频生成参数">
    <h2 className="video-section-title"><SlidersHorizontal size={18} aria-hidden="true" />生成参数</h2>
    <fieldset className="video-ratios"><legend>画幅</legend><div role="group" aria-label="画幅">{sizes.filter(size=>!wan||size!=='21:9').map(size=>{const [w,h]=size==='adaptive'?[1,1]:size.split(':').map(Number);return <button type="button" className="video-ratio" key={size} aria-pressed={values.size===size} disabled={Boolean(ratioReason)} onClick={()=>onChange({size})}><span aria-hidden="true" className={size==='adaptive'?'video-ratio-shape video-ratio-adaptive':'video-ratio-shape'} style={{width:24*w/Math.max(w,h),height:24*h/Math.max(w,h)}} /><span>{size==='adaptive'?'自适应':size}</span></button>;})}</div>{ratioReason && <p className="music-reference-note">{ratioReason}</p>}</fieldset>
    <div className="video-duration-quality"><label className="studio-field"><span>清晰度</span><select aria-label="清晰度" value={values.resolution} disabled={newer && (final || values.workflow==='draft')} onChange={e=>onChange({resolution:e.target.value})}>{wan?<><option value="480p">480P</option><option value="720p">720P</option><option value="1080p">1080P</option></>:h3?<>{h3Max && <option value="480p">480P</option>}<option value="768p">768P</option>{h3Max?<option value="1080p">1080P</option>:<option value="2k">2K</option>}</>:<><option value="480p">480P{!newer&&!standard&&!fast?' · 0.5 积分/秒':''}</option><option value="720p">720P{!newer&&!standard&&!fast?' · 1 积分/秒':''}</option>{(newer||standard) && <option value="1080p">1080P</option>}{standard&&<option value="4k">4K</option>}</>}</select></label>
      <fieldset className="video-duration"><legend>生成时长</legend><div className="video-duration-top">{(newer||wan) && <button type="button" className="video-tool-button" disabled={locked} aria-pressed={auto} onClick={()=>onChange({duration:auto?5:-1})}>自动</button>}<label htmlFor={id+'-seconds'}>{auto?'自动时长':`${duration} 秒`}</label><input id={id+'-seconds'} aria-label="生成时长秒数" type="number" min={min} max={max} step={1} disabled={locked || auto} value={auto?'':duration} placeholder="自动" onChange={e=>setDuration(e.target.value)} /></div><input className="video-duration-slider" aria-label="生成时长" type="range" min={min} max={max} step={1} disabled={locked || auto} value={auto?max:duration} onChange={e=>setDuration(e.target.value)} /><div className="video-duration-ticks"><span>{min} 秒</span><span>{max} 秒</span></div>{locked?<p className="music-reference-note">{final?'时长继承所选样片。':autoVideo?'自动模式由模型确定时长；若为编辑，时长跟随原视频。':'编辑时长跟随源视频，自动确定。'}</p>:auto?<p className="music-reference-note">自动时长按最多 30 秒总计费时长预留，完成按实际用量结算。</p>:null}</fieldset>
    </div>
  </section>;
}
