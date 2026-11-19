"""Seedance 2.5 contract and cost-based half-credit billing (USD/CNY = 7)."""
from decimal import Decimal, InvalidOperation, ROUND_CEILING
from datetime import datetime, timedelta, timezone
import uuid

try:
    from backend.video_provider import VideoError, SIZES, SEEDANCE25_MODELS as MODELS, TASK_ID, video_text
except ModuleNotFoundError:
    from video_provider import VideoError, SIZES, SEEDANCE25_MODELS as MODELS, TASK_ID, video_text

MODEL,FLASH_MODEL=MODELS
FLASH_MEDIA_LIMITS={'image':30*1024*1024-1,'video':200*1024*1024,'audio':15*1024*1024}
USD_CNY=Decimal('7')
CREDIT_CNY=Decimal('0.38')
MARGIN=Decimal('1.2')
# Current public Gold prices, USD/second; used for estimates only.
RATES={'480p':(Decimal('0.09608'),Decimal('0.0576')),
       '720p':(Decimal('0.216'),Decimal('0.1296')),
       '1080p':(Decimal('0.5346'),Decimal('0.3192'))}
# APIMart displays Gold Credits/second (10 Credits = 1 USD).
FLASH_RATES={'480p':(Decimal('0.06312'),Decimal('0.0384')),
             '720p':(Decimal('0.14192'),Decimal('0.0864'))}
PROFILE={'version':'seedance25-draft3d-original-input-half-v3','usd_cny':'7','credit_cny':'0.38','markup':'1.2'}
FLASH_PROFILE={**PROFILE,'version':'seedance25-flash-gold-half-v1'}
FINAL_FIELDS={'model','draft_request_id','resolution','output_format','return_last_frame','watermark'}
FIELDS={'model','prompt','duration','size','resolution','seed','generate_audio','return_last_frame','tools','nsfw_check',
        'draft','draft_request_id','output_format','watermark','omni_reference_task_type'}


def half_credit(value):
    return (value*2).to_integral_value(rounding=ROUND_CEILING)/2


def cost_credits(usd):
    if not isinstance(usd,Decimal) or not usd.is_finite() or usd<0 or usd>1000:
        raise VideoError('VIDEO_BILLING_INVALID','视频计费结果暂不可用，请刷新原任务。',502)
    return half_credit(usd*USD_CNY/CREDIT_CNY*MARGIN)


def normalized_parameters(data):
    if not isinstance(data,dict) or set(data)-FIELDS or data.get('model') not in MODELS:
        raise VideoError('INVALID_VIDEO_INPUT','请选择 Seedance 2.5 支持的参数。')
    flash=data['model']==FLASH_MODEL
    if flash and ('draft' in data or 'draft_request_id' in data):
        raise VideoError('INVALID_VIDEO_INPUT','Seedance 2.5 Flash 不支持样片。')
    final='draft_request_id' in data
    if final and set(data)-FINAL_FIELDS:
        raise VideoError('VIDEO_DRAFT_INHERITED','正式片继承样片的描述、素材、时长和声音设置，请勿再次填写。')
    output=data.get('output_format','mp4')
    if output not in ('mp4','mov'):raise VideoError('INVALID_VIDEO_INPUT','视频输出格式支持 MP4 或 MOV。')
    body={'model':data['model'],'output_format':output}
    switches=[('return_last_frame',False),('watermark',False)]
    if not final:
        switches.extend([('generate_audio',True),('nsfw_check',False)])
        if not flash:switches.append(('draft',False))
    for field,default in switches:
        value=data.get(field,default)
        if type(value) is not bool:raise VideoError('INVALID_VIDEO_INPUT','视频开关参数无效。')
        body[field]=value
    if final:
        try:body['draft_request_id']=str(uuid.UUID(data['draft_request_id']))
        except (ValueError,TypeError,AttributeError):raise VideoError('VIDEO_DRAFT_INVALID','请选择本人的已完成样片。') from None
        if data.get('resolution','1080p')!='1080p':raise VideoError('INVALID_VIDEO_INPUT','样片正式片固定为 1080P。')
        return {**body,'resolution':'1080p'}
    draft=body.get('draft',False);res=data.get('resolution','480p' if draft else '720p')
    kind=data.get('omni_reference_task_type','auto');duration=data.get('duration',-1 if kind=='edit' else 5)
    size=data.get('size','adaptive')
    if flash and (not isinstance(res,str) or res not in FLASH_RATES):
        raise VideoError('INVALID_VIDEO_INPUT','Seedance 2.5 Flash 支持 480P 和 720P。')
    if not isinstance(res,str) or res not in RATES or (draft and res!='480p'):
        raise VideoError('INVALID_VIDEO_INPUT','2.5 支持 480P / 720P / 1080P；样片固定 480P。')
    if kind not in ('auto','reference','edit','extend') or not isinstance(size,str) or size not in SIZES:
        raise VideoError('INVALID_VIDEO_INPUT','请选择有效的视频创作方式与画幅。')
    if type(duration) is not int or not(duration==-1 or 4<=duration<=30):raise VideoError('INVALID_VIDEO_INPUT','生成时长支持 4–30 秒，或自动时长。')
    if kind in {'edit','extend'} and size!='adaptive':raise VideoError('VIDEO_TASK_CONSTRAINT','视频编辑、延长须使用自适应画幅。')
    if kind=='edit' and duration!=-1:raise VideoError('VIDEO_TASK_CONSTRAINT','视频编辑必须选择自动时长，输出时长跟随源视频。')
    prompt=video_text(data.get('prompt',''),'提示词',32000)
    if not prompt:raise VideoError('INVALID_VIDEO_INPUT','Seedance 2.5 需要填写创作描述。')
    body.update(resolution=res,duration=duration,size=size,prompt=prompt,omni_reference_task_type=kind)
    if 'seed' in data:
        if type(data['seed']) is not int or not -1<=data['seed']<=2147483647:raise VideoError('INVALID_VIDEO_INPUT','随机种子须为 -1 至 2147483647 的整数（本站限制）。')
        body['seed']=data['seed']
    if 'tools' in data:
        if data['tools'] not in ([],[{'type':'web_search'}]):raise VideoError('INVALID_VIDEO_INPUT','仅支持联网搜索工具。')
        if data['tools']:body['tools']=data['tools']
    return body


def validate_references(refs,body):
    flash=body.get('model')==FLASH_MODEL
    limits={'image':10,'video':5,'audio':5} if flash else {'image':30,'video':10,'audio':10}
    count_message=f"最多 {limits['image']} 张图片、{limits['video']} 段视频、{limits['audio']} 段音频。"
    if not isinstance(refs,list) or len(refs)>sum(limits.values()) or any(not isinstance(r,dict) or not isinstance(r.get('id'),str) for r in refs):
        raise VideoError('VIDEO_REFERENCE_COUNT',count_message)
    groups={k:[r for r in refs if r.get('kind')==k] for k in ['image','video','audio']}
    if sum(map(len,groups.values()))!=len(refs) or any(len(groups[k])>n for k,n in limits.items()):
        raise VideoError('VIDEO_REFERENCE_COUNT',count_message)
    if len({r['id'] for r in refs})!=len(refs):raise VideoError('VIDEO_REFERENCE_INVALID','同一素材不能重复添加。')
    if 'draft_request_id' in body:
        if refs:raise VideoError('VIDEO_DRAFT_INHERITED','正式片沿用样片素材，请勿再次添加。')
        return 0
    for r in refs:
        role=r.get('role')
        if role and (r['kind']!='image' or role not in ('first_frame','last_frame','reference_image')):raise VideoError('VIDEO_REFERENCE_ROLE','素材角色无效。')
        if flash and r.get('size',0)>FLASH_MEDIA_LIMITS[r['kind']]:
            raise VideoError('VIDEO_REFERENCE_SIZE','Flash 要求图片小于 30 MB、视频不超过 200 MB、音频不超过 15 MB。')
        if r['kind'] in {'image','video'}:
            w,h=r.get('width'),r.get('height')
            if type(w) is not int or type(h) is not int or not(300<=w<=6000 and 300<=h<=6000 and Decimal('0.4')<=Decimal(w)/h<=Decimal('2.5')):
                raise VideoError('VIDEO_REFERENCE_RESOLUTION','2.5 图片和视频边长须为 300–6000 像素，宽高比须为 0.4–2.5。')
        if r['kind']=='video':
            fps=r.get('fps');codec=r.get('codec')
            if not 409600<=r['width']*r['height']<=8295044:
                raise VideoError('VIDEO_REFERENCE_RESOLUTION','2.5 参考视频像素总数须为 409600–8295044。')
            if not flash and not 480<=min(r['width'],r['height'])<=1080:
                raise VideoError('VIDEO_REFERENCE_RESOLUTION','2.5 参考视频须为 480P–1080P，像素总数 409600–8295044。')
            if not isinstance(fps,(float,int)) or not 24<=fps<=60 or codec not in {'avc1','avc3','hvc1','hev1'}:
                raise VideoError('VIDEO_REFERENCE_FORMAT','2.5 参考视频须为 H.264/H.265、24–60 FPS；旧素材请重新添加校验。')
            audio_codecs=r.get('audio_codecs')
            if not r.get('asset_url') and (not isinstance(audio_codecs,list) or any(c not in {'mp4a','.mp3','mp3 '} for c in audio_codecs)):
                raise VideoError('VIDEO_REFERENCE_FORMAT','2.5 参考视频所带音轨须为 AAC 或 MP3，也可以使用无音轨视频；旧素材请重新添加校验。')
        if r['kind']=='audio' and r.get('size',0)>15*1024*1024:raise VideoError('VIDEO_REFERENCE_SIZE','2.5 每段参考音频最多 15 MB。')
        if r['kind'] in {'video','audio'} and (type(r.get('duration_ms')) is not int or not 2000<=r['duration_ms']<=30000):
            raise VideoError('VIDEO_REFERENCE_DURATION','2.5 每段视频或音频须为 2–30 秒。')
    video_ms=sum(r['duration_ms'] for r in groups['video']);audio_ms=sum(r['duration_ms'] for r in groups['audio'])
    if video_ms>30000 or audio_ms>30000:raise VideoError('VIDEO_REFERENCE_DURATION','参考视频总时长、音频总时长分别最多 30 秒。')
    frames=[r['role'] for r in groups['image'] if r.get('role') in {'first_frame','last_frame'}]
    if flash and (len(frames)!=len(set(frames)) or ('last_frame' in frames and 'first_frame' not in frames)):
        raise VideoError('VIDEO_REFERENCE_ROLE','首帧和尾帧各限一张，使用尾帧时须同时提供首帧。')
    if frames and not(groups['video'] or groups['audio']):
        if body.get('size')!='adaptive':raise VideoError('VIDEO_TASK_CONSTRAINT','2.5 首尾帧须选择自适应画幅。')
        if len(frames)!=len(set(frames)):raise VideoError('VIDEO_REFERENCE_ROLE','首帧和尾帧各只能选择一张。')
    kind=body.get('omni_reference_task_type','auto')
    if flash and kind=='reference' and not refs:
        raise VideoError('VIDEO_TASK_CONSTRAINT','参考素材创作至少需要一份素材。')
    if body.get('model')==MODEL and groups['video'] and kind=='auto':
        if body.get('duration')!=-1 or body.get('size')!='adaptive':
            raise VideoError('VIDEO_TASK_CONSTRAINT','带视频的自动判断需使用自动时长和自适应画幅，以兼容视频编辑。请刷新页面核对新预估；需要固定时长可选择参考素材创作或视频延长。')
        if any(r['duration_ms']<4000 for r in groups['video']):
            raise VideoError('VIDEO_TASK_CONSTRAINT','自动判断可能采用视频编辑，参考视频须为 4–30 秒；2–4 秒素材请明确选择参考素材创作或视频延长。')
    if kind in {'edit','extend'} and not groups['video']:raise VideoError('VIDEO_TASK_CONSTRAINT','视频编辑或延长至少需要一段视频。')
    if kind=='edit' and any(r['duration_ms']<4000 for r in groups['video']):raise VideoError('VIDEO_TASK_CONSTRAINT','待编辑视频须为 4–30 秒。')
    return video_ms


def validate_draft_source(source,now=None):
    message='请选择创建未满 3 天、本人已完成并结算的 Seedance 2.5 样片。'
    if not isinstance(source,dict) or source.get('model')!=MODEL or source.get('is_draft') is not True or source.get('status')!='completed' or source.get('billing_status') not in {'settled','not_applicable'} or not isinstance(source.get('provider_task_id'),str) or not TASK_ID.fullmatch(source['provider_task_id']):
        raise VideoError('VIDEO_DRAFT_INVALID',message)
    try:
        created=datetime.fromisoformat(source['created_at'].replace('Z','+00:00'))
        if created.tzinfo is None or created<=(now or datetime.now(timezone.utc))-timedelta(days=3):raise ValueError()
    except (ValueError,TypeError,KeyError,AttributeError):
        raise VideoError('VIDEO_DRAFT_INVALID',message) from None
    requested,ref_ms=source.get('requested_duration'),source.get('reference_duration_ms')
    if type(requested) is not int or not(requested==-1 or 4<=requested<=30) or type(ref_ms) is not int or not 0<=ref_ms<=30000:
        raise VideoError('VIDEO_DRAFT_INVALID','样片原始时长信息不完整，请选择有效样片。')
    return requested,ref_ms


def estimate(body,refs,source=None):
    final='draft_request_id' in body
    if final:
        if refs:raise VideoError('VIDEO_DRAFT_INHERITED','正式片沿用样片素材，请勿再次添加。')
        requested,ref_ms=validate_draft_source(source)
    else:requested=body['duration'];ref_ms=validate_references(refs,body)
    seconds=30 if requested==-1 else requested
    is_flash=body.get('model')==FLASH_MODEL
    rate=(FLASH_RATES if is_flash else RATES)[body['resolution']][1 if ref_ms else 0]
    usd=(Decimal(seconds)+Decimal(ref_ms)/1000)*rate
    # Adaptive/wide frames consume more tokens than the 16:9 public estimate.
    # Reserve 1.6x, settle only the returned actual USD cost, release the rest.
    reserved=cost_credits(usd*Decimal('1.6'))
    return {'estimated':cost_credits(usd),'reserved':reserved,'reference_ms':ref_ms,'requested':requested,
            'estimated_usd':usd,'rate_usd':rate,'profile':FLASH_PROFILE if is_flash else PROFILE}


def actual_cost(data):
    raw=data.get('cost') if isinstance(data,dict) else None
    if isinstance(raw,bool) or not isinstance(raw,(int,float,str,Decimal)):return None
    try:
        cost=Decimal(str(raw))
        if not cost.is_finite() or not 0<cost<=1000:return None
        credits=data.get('credits_cost')
        if credits is not None and abs(Decimal(str(credits))-cost*10)>Decimal('0.00001'):return None
        return cost
    except (ValueError,InvalidOperation):return None
