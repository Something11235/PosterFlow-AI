"""Owner-scoped asynchronous video jobs; submission is never replayed on polling."""
import hashlib
import json
import os
import time
import uuid
from functools import partial

from flask import Blueprint, jsonify, request

try:
    from backend.music_provider import MusicError
    from backend.supabase_service import SupabaseGateway, SupabaseError, is_supabase_configured
    from backend.video_provider import (MODEL, TASK_ID, ASSET_URL, VideoError, normalized_video_parameters,
        video_payload, video_fingerprint, video_price, video_request, normalize_video_task, submit_video, video_endpoints, API)
    from backend import seedance25, seedance20, omni_flash, minimax_h3, wan30, flux3
except ModuleNotFoundError:
    from music_provider import MusicError
    from supabase_service import SupabaseGateway, SupabaseError, is_supabase_configured
    from video_provider import (MODEL, TASK_ID, ASSET_URL, VideoError, normalized_video_parameters,
        video_payload, video_fingerprint, video_price, video_request, normalize_video_task, submit_video, video_endpoints, API)
    import seedance25, seedance20, omni_flash, minimax_h3, wan30, flux3

FIELDS = ('request_id','billing_mode','operation','model','provider_task_id','status','billing_status',
          'resolution','requested_duration','reference_duration_ms','unit_credit_cost','estimated_credits',
          'reserved_credits','charged_credits','generated_count','error_code','created_at','asset_results','is_draft','pricing_profile')
META = ('id','kind','sha256','asset_url','role','duration_ms','width','height')


def public_job(job):
    result = {k: job.get(k) for k in FIELDS}
    if job.get('status') == 'failed':
        try:from backend.video_provider import video_failure
        except ModuleNotFoundError:from video_provider import video_failure
        result['failure_reason'] = video_failure(job.get('error_code'))[1]
    return result


class VideoStore:
    def __init__(self):
        self.gateway = SupabaseGateway()

    def rpc(self, name, body):
        result = self.gateway.rpc(name, body)
        if not isinstance(result, dict) or not result.get('ok'):
            code = result.get('code','VIDEO_DATABASE_UNAVAILABLE') if isinstance(result,dict) else 'VIDEO_DATABASE_UNAVAILABLE'
            message = {'VIDEO_NOT_FOUND':'未找到本人的视频任务。','VIDEO_REQUEST_CONFLICT':'该请求编号对应另一组参数，请查询原任务。',
                       'VIDEO_CONTINUATION_INVALID':'请选择本人已完成并结算的 Omni 任务，且不要同时上传参考视频。',
                       'VIDEO_DRAFT_INVALID':'样片未完成、未结算、已过期或不属于当前账户，请重新选择。',
                       'VIDEO_UNSETTLED_BALANCE':'有视频任务尚待补足积分结算，请先处理原任务。',
                       'VIDEO_BILLING_INVALID':'最终计费结果暂不可用，请刷新原任务核对。',
                       'VIDEO_QUEUE_FULL':'最多同时处理 3 个视频任务，请等待原任务完成。','CREDITS_INSUFFICIENT':'积分不足，请先充值或调整视频时长。',
                       'EMAIL_UNVERIFIED':'请先完成邮箱验证。','ACCOUNT_FROZEN':'当前账户不可用。'}.get(code,'视频任务暂时无法处理，请保留请求编号。')
            raise VideoError(code,message,404 if code=='VIDEO_NOT_FOUND' else 409)
        return result

    def jobs(self, owner, request_id=None):
        params = {'owner_scope':'eq.'+owner,'select':'*','order':'created_at.desc,id.desc','limit':'1' if request_id else '50'}
        if request_id: params['request_id']='eq.'+request_id
        return self.gateway._request('GET','/rest/v1/video_jobs',params=params) or []

    def assets(self, owner):
        rows = self.gateway._request('GET','/rest/v1/video_jobs',params={'owner_scope':'eq.'+owner,'operation':'eq.asset_review',
            'status':'eq.completed','select':'asset_results,created_at','order':'created_at.desc,id.desc','limit':'200'}) or []
        return [a for row in rows for a in row.get('asset_results',[]) if a.get('status')=='Active']

    def apply(self, owner, request_id, event, task_id=None, error_code=None, assets=None):
        return self.rpc('apply_video_job',{'p_owner':owner,'p_request_id':request_id,'p_event':event,
            'p_task_id':task_id,'p_error_code':error_code,'p_assets':assets or []})

    def apply25(self,owner,request_id,event,task_id=None,error_code=None,assets=None,cost=None,tokens=None):
        return self.rpc('apply_seedance25_job',{'p_owner':owner,'p_request_id':request_id,'p_event':event,
            'p_task_id':task_id,'p_error_code':error_code,'p_assets':assets or [],'p_cost_usd':str(cost) if cost is not None else None,'p_tokens':tokens})

    def apply20(self,owner,request_id,event,task_id=None,error_code=None,assets=None,cost=None,tokens=None,model=seedance20.MODEL):
        return self.rpc('apply_seedance20_fast_job' if model==seedance20.FAST_MODEL else 'apply_seedance20_job',{'p_owner':owner,'p_request_id':request_id,'p_event':event,
            'p_task_id':task_id,'p_error_code':error_code,'p_assets':assets or [],'p_cost_usd':str(cost) if cost is not None else None,'p_tokens':tokens})

    def apply_omni(self,owner,request_id,event,task_id=None,error_code=None,assets=None,cost=None,tokens=None):
        return self.rpc('apply_omni_flash_job',{'p_owner':owner,'p_request_id':request_id,'p_event':event,
            'p_task_id':task_id,'p_error_code':error_code,'p_assets':assets or [],'p_cost_usd':str(cost) if cost is not None else None,'p_tokens':tokens})

    def apply_h3(self,owner,request_id,event,task_id=None,error_code=None,assets=None,cost=None,tokens=None):
        return self.rpc('apply_minimax_h3_job',{'p_owner':owner,'p_request_id':request_id,'p_event':event,
            'p_task_id':task_id,'p_error_code':error_code,'p_assets':assets or [],'p_cost_usd':str(cost) if cost is not None else None,'p_tokens':tokens})

    def apply_h3_max(self,owner,request_id,event,task_id=None,error_code=None,assets=None,cost=None,tokens=None):
        return self.rpc('apply_minimax_h3_max_job',{'p_owner':owner,'p_request_id':request_id,'p_event':event,
            'p_task_id':task_id,'p_error_code':error_code,'p_assets':assets or [],'p_cost_usd':str(cost) if cost is not None else None,'p_tokens':tokens})

    def apply_flux(self,owner,request_id,event,task_id=None,error_code=None,assets=None,cost=None,tokens=None):
        return self.rpc('apply_flux3_job',{'p_owner':owner,'p_request_id':request_id,'p_event':event,
            'p_task_id':task_id,'p_error_code':error_code,'p_assets':assets or [],'p_cost_usd':str(cost) if cost is not None else None,'p_tokens':tokens})

    def apply_wan(self,owner,request_id,event,task_id=None,error_code=None,assets=None,cost=None,tokens=None):
        return self.rpc('apply_wan30_job',{'p_owner':owner,'p_request_id':request_id,'p_event':event,
            'p_task_id':task_id,'p_error_code':error_code,'p_assets':assets or [],'p_cost_usd':str(cost) if cost is not None else None,'p_tokens':tokens})


def create_video_blueprint(require_user, rate_limit, allowed_origins, reference_service):
    bp = Blueprint('video',__name__,url_prefix='/api/video')

    @bp.after_request
    def private(response):
        response.headers['Cache-Control']='private, no-store'
        response.headers['X-Content-Type-Options']='nosniff'
        return response

    @bp.errorhandler(VideoError)
    def video_error(error):
        return jsonify(code=error.code,error=error.message,submission_unknown=error.uncertain),error.status

    @bp.errorhandler(MusicError)
    def storage_error(_error):
        return jsonify(code='VIDEO_REFERENCE_STORAGE',error='素材暂未完成处理，请重新添加或稍后重试。'),503

    @bp.errorhandler(SupabaseError)
    def db_error(_error):
        if _error.status in {401,403}:
            return jsonify(code=_error.code,error='请重新登录后使用视频创作。'),_error.status
        return jsonify(code='VIDEO_DATABASE_UNAVAILABLE',error='视频数据库暂未就绪，请保留原任务编号。'),503

    @bp.errorhandler(Exception)
    def unexpected(error):
        if hasattr(error,'message') and hasattr(error,'status'):
            return jsonify(code=error.code,error=error.message),error.status
        return jsonify(code='VIDEO_SERVICE_UNAVAILABLE',error='视频请求暂未确认，请查询原任务，勿重复生成。'),503

    def origin():
        value=request.headers.get('Origin')
        if value and value.rstrip('/') not in {request.host_url.rstrip('/'),*allowed_origins}:
            raise VideoError('VIDEO_ORIGIN_FORBIDDEN','请求来源不受支持。',403)

    def provider_options():
        if request.headers.get('X-Billing-Mode','platform')!='own_key':return {}
        endpoint,query=video_endpoints(request.headers.get('X-Video-Endpoint','').strip(),request.headers.get('X-Video-Query-Template','').strip())
        return {} if endpoint==API+'/videos/generations' and query==API+'/tasks/{task_id}' else {'endpoint':endpoint,'query_template':query}

    def context():
        user=require_user()
        mode=request.headers.get('X-Billing-Mode','platform')
        if mode not in {'platform','own_key'}: raise VideoError('INVALID_BILLING_MODE','请选择有效的计费模式。')
        key=(os.getenv('APIMART_VIDEO_API_KEY','') if mode=='platform' else request.headers.get('X-Video-Api-Key','')).strip()
        if not key or len(key)>4096 or any(ord(c)<33 or ord(c)>126 for c in key):
            raise VideoError('VIDEO_NOT_CONFIGURED' if mode=='platform' else 'VIDEO_KEY_REQUIRED',
                '平台视频服务尚未配置。' if mode=='platform' else '请填写有效的 API Key。',503 if mode=='platform' else 400)
        account=SupabaseGateway().rpc('get_account_snapshot',{'p_user_id':user.id})
        if not account.get('email_verified'): raise VideoError('EMAIL_UNVERIFIED','请先完成邮箱验证。',403)
        if (account.get('profile') or {}).get('status')!='active': raise VideoError('ACCOUNT_FROZEN','当前账户不可用。',403)
        options=provider_options()
        material=json.dumps([key,options['endpoint'],options['query_template']],separators=(',',':')) if options else key
        owner='user-'+user.id+('-'+hashlib.sha256(material.encode()).hexdigest() if mode=='own_key' else '')
        return user.id,mode,key,owner

    def body(required):
        value=request.get_json(silent=True)
        if not isinstance(value,dict) or set(value)!=set(required):raise VideoError('INVALID_VIDEO_INPUT','视频请求参数无效。')
        return value

    def request_id(value):
        try:return str(uuid.UUID(value))
        except (TypeError,ValueError,AttributeError):raise VideoError('INVALID_VIDEO_INPUT','请求编号无效。') from None

    def model_header():
        model=request.headers.get('X-Video-Model',MODEL)
        if model not in {MODEL,seedance25.MODEL,*seedance20.MODELS,omni_flash.MODEL,*minimax_h3.MODELS,wan30.MODEL,flux3.MODEL}:raise VideoError('INVALID_VIDEO_MODEL','该视频模型尚未接入。')
        return model

    def references(raw,owner,store,model=MODEL):
        if not isinstance(raw,list) or len(raw)>(50 if model==seedance25.MODEL else 21 if model==wan30.MODEL else 15):raise VideoError('VIDEO_REFERENCE_COUNT','参考素材数量超出当前模型限制。')
        approved=None;result=[]
        for item in raw:
            if not isinstance(item,dict) or set(item)-{'receipt','asset_url','role'} or ('receipt' in item)==('asset_url' in item):
                raise VideoError('VIDEO_REFERENCE_INVALID','请使用本人上传或审核通过的素材。')
            if 'receipt' in item:
                value=reference_service.verify(item['receipt'],owner,allow_expired=True)
                if model in {wan30.MODEL,flux3.MODEL} and value.get('model')!=model:value=reference_service.revalidate(value,model)
            else:
                if approved is None:approved={a['asset_url']:a for a in store.assets(owner)}
                value=approved.get(item['asset_url']) if isinstance(item['asset_url'],str) else None
                if not value:raise VideoError('VIDEO_ASSET_NOT_FOUND','未找到本人审核通过的素材，请重新选择。',403)
            result.append({**value,**({'role':item['role']} if item.get('role') else {})})
        return result

    def metadata(values,model=MODEL):return [{k:v[k] for k in (*META,*(['fps','codec','size'] if model!=MODEL else []),*(['audio_codecs'] if model in minimax_h3.MODELS else []),*(['pages','has_alpha'] if model==wan30.MODEL else [])) if k in v} for v in values]

    def urls(values):
        if any('asset_url' not in v and v['expires']<=time.time()+900 for v in values):
            raise VideoError('VIDEO_REFERENCE_EXPIRED','素材已过期或临近清理，请重新添加。')
        return [v['asset_url'] if 'asset_url' in v else reference_service.urls([v])[0] for v in values]

    def submit(operation):
        origin();user_id,mode,key,owner=context();rate_limit('video-submit',owner,8,60)
        raw=body(['request_id','parameters','references']);rid=request_id(raw['request_id']);store=VideoStore()
        provider=provider_options()
        if provider and operation=='asset_review':raise VideoError('VIDEO_OPERATION_UNSUPPORTED','当前自定义服务未配置素材审核接口，可直接上传素材进行创作。')
        params=normalized_video_parameters(raw['parameters']) if operation=='generate' else {}
        model=params.get('model',model_header())
        newer=model==seedance25.MODEL
        standard=model in seedance20.MODELS
        omni=model==omni_flash.MODEL
        h3=model in minimax_h3.MODELS
        wan=model==wan30.MODEL
        flux=model==flux3.MODEL
        cost_based=newer or standard or omni or h3 or wan or flux
        if flux and operation=='asset_review':raise VideoError('VIDEO_OPERATION_UNSUPPORTED','FLUX 不支持 Seedance 素材审核。')
        if wan and operation=='asset_review':raise VideoError('VIDEO_OPERATION_UNSUPPORTED','Wan 不支持 Seedance 素材审核。')
        if h3 and operation=='asset_review':raise VideoError('VIDEO_OPERATION_UNSUPPORTED','H3 不支持 Seedance 素材审核，请直接上传或链接导入。')
        if omni and operation=='asset_review':raise VideoError('VIDEO_OPERATION_UNSUPPORTED','Omni 不支持 Seedance 素材审核，请直接上传图片或视频。')
        if operation=='asset_review' and raw['parameters']!={}:raise VideoError('INVALID_VIDEO_INPUT','素材审核无需创作参数。')
        values=references(raw['references'],owner,store,model)
        if operation=='generate' and not newer and not flux:video_price(params,values)
        elif operation!='generate' and (len(values)!=1 or values[0].get('asset_url') or values[0].get('role')):
            raise VideoError('VIDEO_REFERENCE_INVALID','每次选择一份新上传素材进行审核。')
        fingerprint=video_fingerprint({'model':model} if cost_based and operation=='asset_review' else params,values)
        existing=store.jobs(owner,rid)
        if existing:
            if existing[0].get('request_fingerprint')!=fingerprint or existing[0].get('operation')!=operation:
                raise VideoError('VIDEO_REQUEST_CONFLICT','该请求编号对应另一组参数，请查询原任务。',409)
            return jsonify(success=True,job=public_job(existing[0]),idempotent=True)
        source=None
        if newer and operation=='generate':
            seedance25.validate_references(values,params)
            if 'draft_request_id' in params:
                rows=store.jobs(owner,params['draft_request_id']);source=rows[0] if rows else None
                if not source or source.get('model')!=model or not source.get('is_draft') or source.get('status')!='completed' or source.get('billing_status') not in {'settled','not_applicable'}:
                    raise VideoError('VIDEO_DRAFT_INVALID','请选择本人已完成并结算的样片。')
            seedance25.estimate(params,values,source)
        if flux:
            if params.get('draft_request_id'):
                rows=store.jobs(owner,params['draft_request_id']);source=rows[0] if rows else None
            flux3.estimate(params,values,source)
        media_urls=urls(values)
        if omni and params.get('continue_request_id'):
            rows=store.jobs(owner,params['continue_request_id']);source=rows[0] if rows else None
            if not source:raise VideoError('VIDEO_CONTINUATION_INVALID','未找到本人已完成的 Omni 任务。')
        if flux:
            payload=flux3.payload(params,values,media_urls,source)
        elif omni:
            payload=omni_flash.payload(params,values,media_urls,source)
        elif source:
            payload={k:v for k,v in params.items() if k!='draft_request_id'}
            payload['draft_task_id']=source['provider_task_id']
        else:payload=video_payload(params,values,media_urls) if operation=='generate' else {
            'group':{'name':'PosterFlow '+hashlib.sha256(owner.encode()).hexdigest()[:16],'description':'本人创作素材'},
            'asset_type':values[0]['kind'].title(),'assets':[{'url':media_urls[0],'name':'素材 '+values[0]['id'][:20]}]}
        reservation_params=params if operation=='generate' or not cost_based else {'model':model}
        begin_rpc='begin_flux3_job' if flux else 'begin_wan30_job' if wan else 'begin_minimax_h3_max_job' if model==minimax_h3.MAX_MODEL else 'begin_minimax_h3_job' if h3 else 'begin_omni_flash_job' if omni else 'begin_seedance25_job_v2' if newer else 'begin_seedance20_fast_job' if model==seedance20.FAST_MODEL else 'begin_seedance20_job' if standard else 'begin_video_job'
        reserved=store.rpc(begin_rpc,{'p_owner':owner,'p_user_id':user_id,'p_request_id':rid,'p_mode':mode,
            'p_operation':operation,'p_fingerprint':fingerprint,'p_parameters':reservation_params,'p_references':metadata(values,model)})
        apply=store.apply_flux if flux else store.apply_wan if wan else store.apply_h3_max if model==minimax_h3.MAX_MODEL else store.apply_h3 if h3 else store.apply_omni if omni else store.apply25 if newer else partial(store.apply20,model=model) if standard else store.apply
        if reserved.get('existing'):return jsonify(success=True,job=public_job(reserved['job']),idempotent=True)
        try:
            if operation=='generate':task=submit_video(key,payload,**provider)
            else:
                data=video_request('POST','/seedance2/private-avatar',key,payload).get('data')
                task=data.get('id') if isinstance(data,dict) else None
                if not isinstance(task,str) or not TASK_ID.fullmatch(task):
                    raise VideoError('VIDEO_SUBMISSION_UNKNOWN','素材审核提交结果待确认，请保留原编号。',502,True)
        except VideoError as error:
            apply(owner,rid,'submission_unknown' if error.uncertain else 'rejected',error_code=error.code)
            raise
        applied=apply(owner,rid,'submitted',task_id=task)
        return jsonify(success=True,job=public_job(applied['job']),credit_balance=applied.get('balance')),202

    @bp.get('/config')
    def config():
        return jsonify(success=True,model=MODEL,platform_configured=bool(os.getenv('APIMART_VIDEO_API_KEY','').strip()) and is_supabase_configured(),
            database_configured=is_supabase_configured(),references_configured=reference_service.available,
            prices={'480p':'0.5','720p':'1'},billable_references=['video'],reference_retention_hours=12,media_retention_hours=72,
            models=[MODEL,seedance25.MODEL,seedance20.MODEL,seedance20.FAST_MODEL,omni_flash.MODEL,minimax_h3.MODEL,minimax_h3.MAX_MODEL,wan30.MODEL,flux3.MODEL],seedance25_pricing=seedance25.PROFILE,seedance20_pricing=seedance20.PROFILE,seedance20_fast_pricing=seedance20.FAST_PROFILE,omni_flash_pricing=omni_flash.PROFILE,minimax_h3_pricing=minimax_h3.PROFILE,minimax_h3_max_pricing=minimax_h3.MAX_PROFILE,wan30_pricing=wan30.PROFILE,flux3_pricing=flux3.PROFILE)

    @bp.post('/references/uploads')
    def upload():
        origin();uid,_mode,_key,owner=context();rate_limit('video-upload',uid,60,60)
        raw=body(['filename','size','content_type'])
        model=model_header()
        return jsonify(success=True,**reference_service.issue(owner,raw['filename'],raw['size'],raw['content_type'],**({'model':model} if model!=MODEL else {})))

    @bp.post('/references/complete')
    def complete():
        origin();uid,_mode,_key,owner=context();rate_limit('video-verify',uid,60,60)
        return jsonify(success=True,reference=reference_service.complete(owner,body(['upload_ticket'])['upload_ticket']))

    @bp.post('/references/import-url')
    def import_url():
        origin();uid,_mode,_key,owner=context();rate_limit('video-import',uid,10,60)
        raw=body(['url','filename'])
        model=model_header()
        return jsonify(success=True,reference=reference_service.import_url(owner,raw['url'],raw['filename'],**({'model':model} if model!=MODEL else {})))

    @bp.post('/generations')
    def generate():return submit('generate')

    @bp.post('/assets/reviews')
    def review():return submit('asset_review')

    @bp.get('/assets')
    def assets():
        _uid,_mode,_key,owner=context()
        return jsonify(success=True,assets=VideoStore().assets(owner))

    @bp.get('/tasks')
    def jobs():
        _uid,_mode,_key,owner=context()
        return jsonify(success=True,jobs=[public_job(j) for j in VideoStore().jobs(owner)])

    @bp.get('/tasks/<rid>')
    def query(rid):
        uid,_mode,key,owner=context();rate_limit('video-query',uid,60,60)
        rid=request_id(rid);store=VideoStore();rows=store.jobs(owner,rid)
        if not rows:raise VideoError('VIDEO_NOT_FOUND','未找到本人的视频任务。',404)
        job=rows[0]
        if not job.get('provider_task_id') or job['status']=='failed':return jsonify(success=True,job=public_job(job),videos=[])
        task=job['provider_task_id'];payload=video_request('GET','/tasks/'+task+'?language=zh',key,**provider_options())
        result=normalize_video_task(payload,task)
        status=result['status'];assets=[]
        if job['operation']=='asset_review':
            raw=result['raw_result'];candidates=raw.get('usable_assets') or raw.get('assets') or []
            if not candidates and raw.get('asset_url'):
                candidates=[{'asset_url':raw['asset_url'],'asset_id':raw.get('asset_id'),'status':raw.get('status','Active')}]
            if isinstance(candidates,list) and len(candidates)==1 and isinstance(candidates[0],dict):
                a=candidates[0];asset_url=a.get('asset_url')
                if a.get('status')=='Active' and isinstance(asset_url,str) and ASSET_URL.fullmatch(asset_url):
                    assets=[{**job['reference_metadata'][0],'asset_id':asset_url.removeprefix('asset://'),'asset_url':asset_url,'status':'Active'}]
            if assets and status in {'completed','failed'}:status='completed'
        if status=='completed' and (not assets if job['operation']=='asset_review' else not result['videos']):
            return jsonify(success=True,job=public_job(job),videos=[],warning='任务已完成，暂未取得可用结果，请保留原任务编号后刷新。',progress=result['progress'])
        event=status if status in {'completed','failed','unknown'} else 'processing'
        if job.get('model') in {seedance25.MODEL,*seedance20.MODELS,omni_flash.MODEL,*minimax_h3.MODELS,wan30.MODEL,flux3.MODEL}:
            tokens=(payload.get('data',{}).get('usage') or {}).get('completion_tokens')
            tokens=tokens if type(tokens) is int and 0<=tokens<=1000000000 else None
            apply_cost=store.apply_flux if job['model']==flux3.MODEL else store.apply_wan if job['model']==wan30.MODEL else store.apply_h3_max if job['model']==minimax_h3.MAX_MODEL else store.apply_h3 if job['model']==minimax_h3.MODEL else store.apply_omni if job['model']==omni_flash.MODEL else store.apply25 if job['model']==seedance25.MODEL else partial(store.apply20,model=job['model'])
            applied=apply_cost(owner,rid,event,error_code=result['error_code'],assets=assets,cost=seedance25.actual_cost(payload.get('data')),tokens=tokens)
        else:applied=store.apply(owner,rid,event,error_code=result['error_code'],assets=assets)
        visible=applied['job'];settled=visible.get('billing_status') in {'settled','not_applicable'}
        warning='生成已完成，正在等待最终计费结果，请刷新原任务。' if applied.get('billing_pending') else '生成已完成，积分不足以完成差额结算，请补足后刷新原任务。' if visible.get('billing_status')=='awaiting_balance' else None
        return jsonify(success=True,job=public_job(applied['job']),progress=result['progress'],failure_reason=result['failure_reason'],
            videos=result['videos'] if status=='completed' and job['operation']=='generate' and settled else [],credit_balance=applied.get('balance'),warning=warning)

    return bp
