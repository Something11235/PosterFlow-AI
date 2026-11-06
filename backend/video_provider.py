"""Documented Seedance Mini contract, exact pricing and fixed provider routes."""
import hashlib
import json
import math
import re
from urllib.parse import urlsplit
from decimal import Decimal

import requests

try:
    from backend.music_provider import safe_media_url, custom_endpoints, pinned_custom_response, MusicError
except ModuleNotFoundError:
    from music_provider import safe_media_url, custom_endpoints, pinned_custom_response, MusicError

MODEL = 'seedance-2.0-mini'
API = 'https://api.apimart.ai/v1'
TASK_ID = re.compile(r'^[A-Za-z0-9_-]{8,160}$')
ASSET_URL = re.compile(r'^asset://[A-Za-z0-9_-]{4,160}$')
PRICES = {'480p': Decimal('0.5'), '720p': Decimal('1')}
SIZES = {'16:9','9:16','1:1','4:3','3:4','21:9','adaptive'}


class VideoError(Exception):
    def __init__(self, code, message, status=400, uncertain=False):
        super().__init__(message)
        self.code, self.message, self.status, self.uncertain = code, message, status, uncertain


def validate_image_dimensions(width, height):
    if type(width) is not int or type(height) is not int or not (300 <= width <= 6000 and 300 <= height <= 6000):
        raise VideoError('VIDEO_REFERENCE_RESOLUTION', f'参考图片的宽和高均须为 300–6000 像素；当前为 {width} × {height}，请调整尺寸后重新上传。')
    if not 0.4 <= width / height <= 2.5:
        raise VideoError('VIDEO_REFERENCE_RESOLUTION', f'参考图片宽高比须为 0.4–2.5；当前为 {width} × {height}，请调整比例后重新上传。')


def video_text(value, label, maximum):
    if not isinstance(value, str) or len(value.strip()) > maximum:
        raise VideoError('INVALID_VIDEO_INPUT', f'{label}须为文字，最多 {maximum} 个字符（本站限制）。')
    return value.strip()


def normalized_video_parameters(data):
    if isinstance(data,dict) and data.get('model')=='flux-3-video':
        try:from backend.flux3 import normalized_parameters
        except ModuleNotFoundError:from flux3 import normalized_parameters
        return normalized_parameters(data)
    if isinstance(data,dict) and 'model' in data and not isinstance(data['model'],str):
        raise VideoError('INVALID_VIDEO_MODEL','视频型号须为有效名称。')
    if isinstance(data,dict) and data.get('model')=='wan3.0-video':
        try:from backend.wan30 import normalized_parameters
        except ModuleNotFoundError:from wan30 import normalized_parameters
        return normalized_parameters(data)
    if isinstance(data,dict) and data.get('model') in {'MiniMax-H3','MiniMax-H3-Max'}:
        try:from backend.minimax_h3 import normalized_parameters
        except ModuleNotFoundError:from minimax_h3 import normalized_parameters
        return normalized_parameters(data)
    if isinstance(data,dict) and data.get('model')=='gemini-omni-1.1-flash':
        try:from backend.omni_flash import normalized_parameters
        except ModuleNotFoundError:from omni_flash import normalized_parameters
        return normalized_parameters(data)
    if isinstance(data,dict) and data.get('model') in {'seedance-2.0','seedance-2.0-fast'}:
        try:from backend.seedance20 import normalized_parameters
        except ModuleNotFoundError:from seedance20 import normalized_parameters
        return normalized_parameters(data)
    if isinstance(data,dict) and data.get('model')=='seedance-2.5':
        try:from backend.seedance25 import normalized_parameters
        except ModuleNotFoundError:from seedance25 import normalized_parameters
        return normalized_parameters(data)
    allowed = {'model','prompt','duration','size','resolution','seed','generate_audio','return_last_frame','tools','nsfw_check'}
    if not isinstance(data, dict) or set(data)-allowed or data.get('model',MODEL) != MODEL:
        raise VideoError('INVALID_VIDEO_MODEL','请选择 Seedance 2.0 Mini 及其支持的参数。')
    resolution = data.get('resolution','720p')
    duration, size = data.get('duration',5), data.get('size','16:9')
    if resolution not in PRICES or type(duration) is not int or not 4 <= duration <= 15 or size not in SIZES:
        raise VideoError('INVALID_VIDEO_INPUT','Mini 支持 480P / 720P、4–15 秒和列表中的画幅。')
    body = {'model':MODEL,'prompt':video_text(data.get('prompt',''),'提示词',32000),'duration':duration,'size':size,'resolution':resolution}
    for name,default in [('generate_audio',True),('return_last_frame',False),('nsfw_check',False)]:
        value=data.get(name,default)
        if type(value) is not bool: raise VideoError('INVALID_VIDEO_INPUT','视频开关参数无效。')
        body[name]=value
    if 'seed' in data:
        if type(data['seed']) is not int or not -1 <= data['seed'] <= 2147483647:
            raise VideoError('INVALID_VIDEO_INPUT','随机种子须为 -1 至 2147483647 之间的整数（本站限制）。')
        body['seed']=data['seed']
    if 'tools' in data:
        if data['tools'] not in ([],[{'type':'web_search'}]): raise VideoError('INVALID_VIDEO_INPUT','仅支持联网搜索工具。')
        if data['tools']:body['tools']=data['tools']
    return body


def validate_video_references(references,parameters=None):
    if isinstance(parameters,dict) and parameters.get('model')=='flux-3-video':
        try:from backend.flux3 import validate_references
        except ModuleNotFoundError:from flux3 import validate_references
        return validate_references(references,parameters)
    if isinstance(parameters,dict) and parameters.get('model')=='wan3.0-video':
        try:from backend.wan30 import validate_references
        except ModuleNotFoundError:from wan30 import validate_references
        return validate_references(references,parameters)
    if parameters and parameters.get('model')=='MiniMax-H3':
        try:from backend.minimax_h3 import validate_references
        except ModuleNotFoundError:from minimax_h3 import validate_references
        return validate_references(references,parameters)
    if parameters and parameters.get('model')=='gemini-omni-1.1-flash':
        try:from backend.omni_flash import validate_references
        except ModuleNotFoundError:from omni_flash import validate_references
        return validate_references(references,parameters)
    if parameters and parameters.get('model')=='seedance-2.5':
        try:from backend.seedance25 import validate_references
        except ModuleNotFoundError:from seedance25 import validate_references
        return validate_references(references,parameters)
    if not isinstance(references,list) or len(references)>15 or any(not isinstance(r,dict) or not isinstance(r.get('id'),str) for r in references):
        raise VideoError('VIDEO_REFERENCE_COUNT','最多 9 张图片、3 段视频和 3 段音频。')
    groups={kind:[r for r in references if r.get('kind')==kind] for kind in ['image','video','audio']}
    if sum(map(len,groups.values()))!=len(references) or any(len(groups[k])>n for k,n in [('image',9),('video',3),('audio',3)]):
        raise VideoError('VIDEO_REFERENCE_COUNT','最多 9 张图片、3 段视频和 3 段音频。')
    ids=[r['id'] for r in references]
    if len(set(ids))!=len(ids):raise VideoError('VIDEO_REFERENCE_INVALID','同一素材不能重复添加。')
    for ref in groups['image']:
        # Approved asset IDs have already passed upstream material validation.
        if not ASSET_URL.fullmatch(ref.get('asset_url','')):
            validate_image_dimensions(ref.get('width'), ref.get('height'))
    roles=[r.get('role') for r in references if r.get('role')]
    if any(r.get('role') and r['kind']!='image' for r in references) or any(x not in {'first_frame','last_frame','reference_image'} for x in roles):
        raise VideoError('VIDEO_REFERENCE_ROLE','图片角色无效。')
    if roles and len(roles)!=len(groups['image']):raise VideoError('VIDEO_REFERENCE_ROLE','普通参考图与带角色图片不能混用。')
    frames=any(x in {'first_frame','last_frame'} for x in roles)
    if frames and (groups['video'] or groups['audio'] or len(roles)>2 or len(set(roles))!=len(roles) or 'reference_image' in roles):
        raise VideoError('VIDEO_REFERENCE_ROLE','首尾帧模式仅使用首帧、尾帧各一张图片，不能同时使用参考视频或音频。')
    if any(r.get('role')=='reference_image' and not ASSET_URL.fullmatch(r.get('asset_url','')) for r in references):
        raise VideoError('VIDEO_REFERENCE_ROLE','参考人像角色需要已审核通过的素材。')
    if groups['audio'] and not(groups['image'] or groups['video']):raise VideoError('VIDEO_REFERENCE_AUDIO','参考音频需要搭配参考图片或视频。')
    totals={}
    for kind in ['video','audio']:
        values=[r.get('duration_ms') for r in groups[kind]]
        if any(type(v) is not int or not 2000 <= v <= 15000 for v in values):raise VideoError('VIDEO_REFERENCE_DURATION','2.0 系列参考视频和音频每段须为 2–15 秒，请调整时长后重新添加。')
        totals[kind]=sum(values)
    if groups['video'] and not 1800 < totals['video'] < 15200:
        raise VideoError('VIDEO_REFERENCE_DURATION','参考视频总时长须大于 1.8 秒、小于 15.2 秒。')
    if totals['audio']>15000:raise VideoError('VIDEO_REFERENCE_DURATION','参考音频总时长不能超过 15 秒。')
    for r in groups['video']:
        if type(r.get('width')) is not int or type(r.get('height')) is not int or not 480 <= min(r['width'],r['height']) <= 720:
            raise VideoError('VIDEO_REFERENCE_RESOLUTION','参考视频须为 480P 至 720P，请先调整分辨率。')
    return totals['video']


def video_price(body, references):
    if body.get('model')=='flux-3-video':
        try:from backend.flux3 import estimate
        except ModuleNotFoundError:from flux3 import estimate
        return estimate(body,references)['reserved']
    if body.get('model')=='wan3.0-video':
        try:from backend.wan30 import estimate
        except ModuleNotFoundError:from wan30 import estimate
        return estimate(body,references)['reserved']
    if body.get('model') in {'MiniMax-H3','MiniMax-H3-Max'}:
        try:from backend.minimax_h3 import estimate
        except ModuleNotFoundError:from minimax_h3 import estimate
        return estimate(body,references)['reserved']
    if body.get('model')=='gemini-omni-1.1-flash':
        try:from backend.omni_flash import estimate
        except ModuleNotFoundError:from omni_flash import estimate
        return estimate(body,references)['reserved']
    if body.get('model') in {'seedance-2.0','seedance-2.0-fast'}:
        try:from backend.seedance20 import estimate
        except ModuleNotFoundError:from seedance20 import estimate
        return estimate(body,references)['reserved']
    if body.get('model')=='seedance-2.5':
        try:from backend.seedance25 import estimate
        except ModuleNotFoundError:from seedance25 import estimate
        return estimate(body,references)['reserved']
    reference_ms=validate_video_references(references)
    # Only video input duration is billable. Images/audio do not add seconds.
    return (Decimal(reference_ms)/1000+body['duration'])*PRICES[body['resolution']]


def video_payload(body, references, urls):
    if body.get('model')=='flux-3-video':
        try:from backend.flux3 import payload
        except ModuleNotFoundError:from flux3 import payload
        return payload(body,references,urls)
    if body.get('model')=='wan3.0-video':
        try:from backend.wan30 import payload
        except ModuleNotFoundError:from wan30 import payload
        return payload(body,references,urls)
    if body.get('model') in {'MiniMax-H3','MiniMax-H3-Max'}:
        try:from backend.minimax_h3 import payload
        except ModuleNotFoundError:from minimax_h3 import payload
        return payload(body,references,urls)
    if body.get('model')=='gemini-omni-1.1-flash':
        try:from backend.omni_flash import payload
        except ModuleNotFoundError:from omni_flash import payload
        return payload(body,references,urls)
    validate_video_references(references,body)
    if len(urls)!=len(references) or any(not(safe_media_url(url) or ASSET_URL.fullmatch(url)) for url in urls):
        raise VideoError('VIDEO_REFERENCE_INVALID','尚未取得有效素材地址。')
    if not references and not body.get('prompt') and 'draft_task_id' not in body:raise VideoError('INVALID_VIDEO_INPUT','文生视频需要填写提示词。')
    result={**body};images=[];roles=[];videos=[];audios=[]
    # A single ordered image array keeps @图片N stable when ordinary references
    # and explicit frame roles are mixed. Never split that sequence in 2.5.
    use_roles=body.get('model')=='seedance-2.5' and any(r['kind']=='image' and r.get('role') for r in references)
    for ref,url in zip(references,urls):
        if ref['kind']=='image':
            if ref.get('role') or use_roles:roles.append({'url':url,'role':ref.get('role') or 'reference_image'})
            else:images.append(url)
        elif ref['kind']=='video':videos.append(url)
        else:audios.append(url)
    for key,value in [('image_urls',images),('image_with_roles',roles),('video_urls',videos),('audio_urls',audios)]:
        if value:result[key]=value
    return result


def video_fingerprint(body, references):
    keys=['id','kind','sha256','asset_url','role','duration_ms','width','height']
    if body.get('model') in {'seedance-2.5','seedance-2.0','seedance-2.0-fast','MiniMax-H3','MiniMax-H3-Max','wan3.0-video','flux-3-video'}:keys+=['fps','codec','size']
    if body.get('model') in {'MiniMax-H3','MiniMax-H3-Max'}:keys+=['audio_codecs']
    if body.get('model')=='wan3.0-video':keys+=['pages','has_alpha']
    stable=[{key:r[key] for key in keys if key in r} for r in references]
    return hashlib.sha256(json.dumps({'parameters':body,'references':stable},sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()


def video_failure(error):
    try:from backend.generation_failures import error_text, is_timeout
    except ModuleNotFoundError:from generation_failures import error_text, is_timeout
    raw=error_text(error)
    if is_timeout(error):return 'VIDEO_PROVIDER_TIMEOUT','视频服务响应超时，请至少等待 2 分钟后查询原任务，勿重复提交。'
    for code,pattern,message in [
        ('VIDEO_OMNI_FRAME_INVALID',r'invalid_frame_images','首尾帧参数不符合要求：尾帧必须搭配首帧，建议使用相同比例并与所选画幅一致。'),
        ('VIDEO_CONTINUATION_INVALID',r'VIDEO_CONTINUATION_INVALID|invalid_extend_from_task|extend_from_task.{0,100}(?:invalid|not.found|owner|completed)','未找到可继续使用的本人 Omni 任务，请选择已完成并结算的本型号任务，且不要同时上传参考视频。'),
        ('VIDEO_REFERENCE_DURATION',r'DurationTooShort|DurationTooLong|(?:duration|时长).{0,80}(?:must be between|too.short|too.long|不符合)','参考音频或视频时长不符合要求：Mini 每段须为 2–15 秒，2.5 每段须为 2–30 秒；请调整时长后重新添加。'),
        ('VIDEO_REFERENCE_RESOLUTION',r'(?:Width|Height)(?:TooSmall|TooLarge)|(?:width|height).{0,60}(?:between\s*300|6000px)|(?:aspect.ratio).{0,50}(?:invalid|range|between)','参考图片尺寸不符合要求：宽和高均须为 300–6000 像素，宽高比须为 0.4–2.5。请调整图片后重新上传。'),
        ('VIDEO_TASK_CONSTRAINT',r'TaskTypeMismatch|TaskTypeConstraint|InvalidParameter\.(?:Duration|TaskType)|(?:duration|时长).{0,80}(?:invalid|无效|必须|must)|参数.{0,30}duration','任务描述与创作方式或参数不匹配。编辑须使用自适应画幅和自动时长，源视频须为 4–30 秒；延长须使用自适应画幅。参考创作请避免编辑、替换、删除或续写等指令。'),
        ('VIDEO_DRAFT_INVALID',r'draft.{0,80}(?:expire|not.found|invalid|owner)|样片.*(?:过期|不存在|不属于)','样片未完成、已过期或不属于当前服务，请选择本人最近 7 天内已完成的样片。'),
        ('VIDEO_CONTENT_REJECTED',r'moderat|nsfw|content.*(?:policy|reject)|审核|敏感|违禁','提示词或参考素材未通过内容审核，请按提示调整后重试。'),
        ('VIDEO_PROVIDER_BALANCE',r'insufficient[_\s.-]*(?:quota|balance|credit|fund)|(?:quota|balance|credit).{0,35}(?:insufficient|exceed|exhaust|deplet|not enough|too low)|(?:余额|额度).{0,12}(?:不足|耗尽|用尽)|欠费','视频服务额度不足，请联系站主；自带 Key 请检查服务余额。'),
        ('VIDEO_PROVIDER_PERMISSION',r'auth|permission|api.?key|权限|密钥','视频服务密钥或模型权限不可用，请检查配置。'),
        ('VIDEO_REFERENCE_INVALID',r'(?:image|video|audio|asset|reference).{0,100}(?:invalid|unsupported|unavailable|duration|resolution|not found)|素材|图片|时长|分辨率','参考素材或视频参数不符合要求，请检查格式、时长、分辨率和素材审核状态。'),
        ('VIDEO_PROVIDER_BUSY',r'rate_limit|too many|busy|capacity|繁忙|频繁','视频服务当前繁忙，请稍后重试。'),
        ('VIDEO_PROVIDER_TIMEOUT',r'timeout|timed out|超时','视频服务未能及时完成任务，请保留原任务编号核对。')]:
        if raw == code or re.search(pattern,raw,re.I|re.S):return code,message
    return 'VIDEO_TASK_FAILED','视频生成未完成，请保留任务编号核对；预留积分按最终任务结果处理。'


def video_endpoints(endpoint,query_template=''):
    endpoint=endpoint or API+'/videos/generations'
    if not query_template:
        parsed=urlsplit(endpoint)
        query_template=endpoint.removesuffix('/videos/generations')+'/tasks/{task_id}' if parsed.path.endswith('/videos/generations') else endpoint.rstrip('/').rsplit('/',1)[0]+'/tasks/{task_id}'
    try:return custom_endpoints(endpoint,query_template)
    except (MusicError,ValueError):raise VideoError('VIDEO_ENDPOINT_INVALID','生成和查询接口须为同一域名的完整公网 HTTPS 地址；查询地址包含一次 {task_id}，不含凭据或查询参数。') from None


def video_request(method,path,key,body=None,endpoint=None,query_template=None):
    if not ((method=='POST' and path in ['/videos/generations','/seedance2/private-avatar']) or (method=='GET' and re.fullmatch(r'/tasks/[A-Za-z0-9_-]{8,160}\?language=zh',path))):
        raise VideoError('INVALID_VIDEO_ROUTE','视频服务地址无效。')
    try:
        headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'}
        if endpoint:
            endpoint,query_template=video_endpoints(endpoint,query_template)
        custom=bool(endpoint and (endpoint!=API+'/videos/generations' or query_template!=API+'/tasks/{task_id}'))
        if custom:
            if path=='/seedance2/private-avatar':raise VideoError('VIDEO_OPERATION_UNSUPPORTED','当前自定义服务未配置素材审核接口；可直接上传素材进行创作。')
            url=endpoint if method=='POST' else query_template.replace('{task_id}',path.split('/')[2].split('?')[0])
            response=pinned_custom_response(method,url,headers,body)
        else:response=requests.request(method,API+path,headers=headers,json=body,timeout=(8,35),allow_redirects=False,stream=True)
        with response:
            chunks=[];size=0
            for chunk in response.iter_content(65536):
                size+=len(chunk)
                if size>2*1024*1024:raise ValueError('large response')
                chunks.append(chunk)
            payload=json.loads(b''.join(chunks))
    except MusicError:
        raise VideoError('VIDEO_ENDPOINT_PRIVATE','自定义视频接口不能指向本机、私网或不可安全解析的地址。',400) from None
    except (requests.RequestException,ValueError) as exc:
        raise VideoError('VIDEO_SUBMISSION_UNKNOWN' if method=='POST' else 'VIDEO_QUERY_UNAVAILABLE',
            '暂未确认提交结果，请保留请求编号，勿重复生成。' if method=='POST' else '视频任务查询暂不可用，请刷新原任务。',503,method=='POST') from None
    if not 200 <= response.status_code < 300 or not isinstance(payload,dict) or payload.get('code')!=200:
        rejected=response.status_code in {400,401,402,403,404,422,429} and isinstance(payload,dict) and isinstance(payload.get('error'),dict)
        if method=='GET':raise VideoError('VIDEO_QUERY_UNAVAILABLE','暂未取得最新任务状态，这不表示生成失败，请刷新原任务。',502)
        code,message=video_failure(payload.get('error') if isinstance(payload,dict) else None)
        raise VideoError(code if rejected else 'VIDEO_SUBMISSION_UNKNOWN',message if rejected else '提交结果待确认，请保留原请求编号，勿重复生成。',502,not rejected)
    return payload


def submit_video(key,body,endpoint=None,query_template=None):
    result=video_request('POST','/videos/generations',key,body,**({'endpoint':endpoint,'query_template':query_template} if endpoint else {}));data=result.get('data')
    task=data[0].get('task_id') if isinstance(data,list) and len(data)==1 and isinstance(data[0],dict) else None
    if not isinstance(task,str) or not TASK_ID.fullmatch(task):raise VideoError('VIDEO_SUBMISSION_UNKNOWN','视频服务已响应，但未能确认任务编号，请勿重复生成。',502,True)
    return task


def normalize_video_task(payload,task_id):
    data=payload.get('data') if isinstance(payload,dict) else None
    if not isinstance(data,dict) or data.get('id')!=task_id:raise VideoError('VIDEO_BAD_RESPONSE','视频任务响应无效，请保留原编号后刷新。',502)
    status=data.get('status','unknown');status=status if status in {'submitted','pending','processing','completed','failed','cancelled','unknown'} else 'unknown'
    progress=data.get('progress',0);progress=max(0,min(100,progress)) if type(progress) in [int,float] and math.isfinite(progress) else 0
    result=data.get('result') if isinstance(data.get('result'),dict) else {};videos=result.get('videos',[])
    if not isinstance(videos,list) or len(videos)>16:raise VideoError('VIDEO_BAD_RESPONSE','视频结果格式异常，请保留原编号后刷新。',502)
    output=[]
    for item in videos:
        if not isinstance(item,dict):continue
        urls=item.get('url',[]);urls=[urls] if isinstance(urls,str) else urls
        url=next((safe_media_url(x) for x in urls[:8] if safe_media_url(x)),None) if isinstance(urls,list) else None
        if not url:continue
        expiry=item.get('expires_at');expiry=expiry if type(expiry) is int and expiry>0 else None
        last_frame=''
        for source in [item,result,data]:
            for field in ['last_frame_url','last_frame_image_url','last_frame']:
                value=source.get(field);value=value.get('url') if isinstance(value,dict) else value
                if isinstance(value,list):value=value[0] if value else ''
                last_frame=last_frame or safe_media_url(value)
        output.append({'url':url,'expires_at':expiry,'last_frame_url':last_frame})
    code,message=video_failure(data.get('error')) if status in {'failed','cancelled'} else (None,None)
    return {'status':'failed' if status=='cancelled' else status,'progress':progress,'videos':output,
            'error_code':code,'failure_reason':message,'raw_result':result}
