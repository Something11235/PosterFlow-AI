"""Private, owner-bound image/video/audio references with verified media metadata."""
import base64
import hashlib
import hmac
import io
import json
import math
import re
import time
import uuid
import wave

from PIL import Image
from tinytag import TinyTag

try:
    from backend.music_provider import pinned_custom_response, safe_media_url
    from backend.music_references import MusicReferences
    from backend.video_provider import VideoError, validate_image_dimensions
    from backend import seedance25
except ModuleNotFoundError:
    from music_provider import pinned_custom_response, safe_media_url
    from music_references import MusicReferences
    from video_provider import VideoError, validate_image_dimensions
    import seedance25

LIMITS={'image':16*1024*1024,'audio':20*1024*1024,'video':50*1024*1024}
TYPES={'png':('image','image/png'),'jpg':('image','image/jpeg'),'jpeg':('image','image/jpeg'),
       'webp':('image','image/webp'),'mp3':('audio','audio/mpeg'),'wav':('audio','audio/wav'),
       'mp4':('video','video/mp4'),'mov':('video','video/quicktime'),
       'heic':('image','image/heic'),'heif':('image','image/heif')}
try:from backend.wan_documents import MIMES as DOCUMENT_MIMES
except ModuleNotFoundError:from wan_documents import MIMES as DOCUMENT_MIMES
TYPES.update({ext:('document',mime) for ext,mime in DOCUMENT_MIMES.items()})
TYPES.update({'bmp':('image','image/bmp'),'gif':('image','image/gif'),
              'tif':('image','image/tiff'),'tiff':('image','image/tiff')})
REFERENCE_ID=re.compile(r'^[0-9]{10}-[a-f0-9]{32}\.(png|jpe?g|webp|bmp|gif|tiff?|heic|heif|mp3|wav|mp4|mov|pdf|docx?|xlsx?|pptx?|txt|md|key|pages|numbers)$')


def image_formats(model):
    formats={'png':'PNG','jpg':'JPEG','jpeg':'JPEG','webp':'WEBP'}
    if model in {seedance25.FLASH_MODEL,'wan3.0-video'}:formats['bmp']='BMP'
    if model in {seedance25.FLASH_MODEL,'MiniMax-H3','MiniMax-H3-Max'}:formats.update(heic='HEIF',heif='HEIF')
    if model==seedance25.FLASH_MODEL:formats.update(gif='GIF',tif='TIFF',tiff='TIFF')
    return formats


def media_limits(model):
    if model==seedance25.FLASH_MODEL:return seedance25.FLASH_MEDIA_LIMITS
    if model=='wan3.0-video':
        try:from backend.wan30 import LIMITS as wan_limits
        except ModuleNotFoundError:from wan30 import LIMITS as wan_limits
        return wan_limits
    if model in {'MiniMax-H3','MiniMax-H3-Max'}:
        try:from backend.minimax_h3 import LIMITS as h3_limits
        except ModuleNotFoundError:from minimax_h3 import LIMITS as h3_limits
        return h3_limits
    return LIMITS


def enable_heif(extension):
    if extension in {'heic','heif'}:
        import pillow_heif
        pillow_heif.register_heif_opener()


def mp4_metadata(data):
    """Bounded ISO-BMFF movie/track headers; no shell, ffmpeg or user codecs."""
    view=memoryview(data);budget=[0]
    def boxes(start,end):
        while start<end:
            budget[0]+=1
            if budget[0]>10000 or end-start<8:raise ValueError('invalid atom count')
            size=int.from_bytes(view[start:start+4],'big');kind=bytes(view[start+4:start+8]);header=8
            if size==1:
                if end-start<16:raise ValueError('invalid extended atom')
                size=int.from_bytes(view[start+8:start+16],'big');header=16
            elif size==0:size=end-start
            if size<header or start+size>end:raise ValueError('invalid atom size')
            yield kind,start+header,start+size
            start+=size
    def duration(start,end):
        if end-start<20:raise ValueError('invalid time header')
        version=view[start];offset=20 if version==1 else 12
        if version not in [0,1] or start+offset+(12 if version else 8)>end:raise ValueError('invalid time version')
        scale=int.from_bytes(view[start+offset:start+offset+4],'big')
        ticks=int.from_bytes(view[start+offset+4:start+offset+(12 if version else 8)],'big')
        if scale<=0 or ticks<=0:raise ValueError('invalid duration')
        return ticks/scale
    movie_duration=None;video_duration=None;width=height=None;has_media=False;has_movie=False;video_tracks=0;frame_count=None;codec=None;audio_codecs=[]
    for kind,start,end in boxes(0,len(view)):
        if kind==b'mdat' and end>start:has_media=True
        if kind!=b'moov':continue
        has_movie=True
        for sub,a,b in boxes(start,end):
            if sub==b'mvhd':movie_duration=duration(a,b)
            if sub!=b'trak':continue
            track_width=track_height=None;handler=None;track_duration=None;track_frames=None;track_codec=None
            for atom,c,d in boxes(a,b):
                if atom==b'tkhd' and d-c>=84:
                    track_width=int.from_bytes(view[d-8:d-4],'big')>>16
                    track_height=int.from_bytes(view[d-4:d],'big')>>16
                if atom==b'mdia':
                    for inner,e,f in boxes(c,d):
                        if inner==b'hdlr' and f-e>=12:handler=bytes(view[e+8:e+12])
                        if inner==b'mdhd':track_duration=duration(e,f)
                        if inner==b'minf':
                            for sample,g,h in boxes(e,f):
                                if sample!=b'stbl':continue
                                for table,i,j in boxes(g,h):
                                    if table==b'stsz' and j-i>=12:track_frames=int.from_bytes(view[i+8:i+12],'big')
                                    if table==b'stsd' and j-i>=16:
                                        count=int.from_bytes(view[i+4:i+8],'big')
                                        if count!=1:raise ValueError('unsupported sample descriptions')
                                        for coding,_,_ in boxes(i+8,j):track_codec=coding.decode('ascii')
            if handler==b'vide':
                video_tracks+=1
                width,height=track_width,track_height;video_duration=track_duration
                frame_count,codec=track_frames,track_codec
            elif handler==b'soun':audio_codecs.append(track_codec or 'unknown')
    seconds=max(movie_duration or 0,video_duration or 0)
    if video_tracks!=1 or not has_media or not has_movie or not seconds or not width or not height or not math.isfinite(seconds):
        raise ValueError('missing video stream')
    return {'duration_ms':round(seconds*1000),'width':width,'height':height,'audio_codecs':audio_codecs,
            **({'fps':round(frame_count/video_duration,6),'codec':codec} if frame_count and video_duration and codec else {})}


def reference_metadata(data,extension,model='seedance-2.0-mini'):
    kind,mime=TYPES[extension]
    wan=model=='wan3.0-video'
    flux=model=='flux-3-video'
    flash=model==seedance25.FLASH_MODEL
    if flux and (kind not in {'image','video'} or kind=='video' and extension!='mp4'):raise VideoError('VIDEO_REFERENCE_TYPE','FLUX 支持 JPG / PNG / WebP 或 MP4，不支持独立音频。')
    if kind=='document':
        if not wan:raise VideoError('VIDEO_REFERENCE_TYPE','当前模型不支持参考文档。')
        try:from backend.wan_documents import metadata
        except ModuleNotFoundError:from wan_documents import metadata
        return metadata(data,extension)
    if kind=='image' and extension not in image_formats(model):raise VideoError('VIDEO_REFERENCE_TYPE','当前模型不支持该图片格式。')
    omni=model=='gemini-omni-1.1-flash'
    h3=model in {'MiniMax-H3','MiniMax-H3-Max'}
    enable_heif(extension)
    if omni and kind=='audio':raise VideoError('VIDEO_REFERENCE_TYPE','Omni 不支持上传参考音频，请使用图片或视频。')
    if not data or len(data)>media_limits(model)[kind]:raise VideoError('VIDEO_REFERENCE_SIZE','参考素材大小超出当前模型限制。')
    if kind=='audio' and model=='seedance-2.5' and len(data)>15*1024*1024:raise VideoError('VIDEO_REFERENCE_SIZE','2.5 每段参考音频最多 15 MB。')
    try:
        if kind=='image':
            with Image.open(io.BytesIO(data)) as img:
                expected=image_formats(model)[extension]
                if img.format!=expected or img.width*img.height>(64000000 if wan else 5760*5760 if h3 else 36_000_000 if flash else 32_000_000) or min(img.size)<1:raise ValueError('invalid image')
                if wan and extension=='png' and ('A' in img.getbands() or 'transparency' in img.info):raise VideoError('VIDEO_REFERENCE_FORMAT','Wan 不支持带透明通道的 PNG，请转换为不透明 PNG 或 JPG。')
                has_alpha=extension=='png' and ('A' in img.getbands() or 'transparency' in img.info)
                width,height=img.size;img.verify()
            info={'width':width,'height':height,'has_alpha':has_alpha}
            if wan:
                try:from backend.wan30 import validate_dimensions
                except ModuleNotFoundError:from wan30 import validate_dimensions
                validate_dimensions(width,height)
            elif h3:
                try:from backend.minimax_h3 import validate_image
                except ModuleNotFoundError:from minimax_h3 import validate_image
                validate_image(width,height)
            elif not omni and not flux:validate_image_dimensions(width, height)
        elif kind=='video':
            info=mp4_metadata(data)
            if wan:
                try:from backend.wan30 import validate_references
                except ModuleNotFoundError:from wan30 import validate_references
                validate_references([{'id':'verified-file','kind':'video','size':len(data),**info}],{'duration':-1},require_content=False)
            elif h3:
                try:from backend.minimax_h3 import validate_references
                except ModuleNotFoundError:from minimax_h3 import validate_references
                validate_references([{'id':'verified-file','kind':'video','size':len(data),**info}],{'model':model})
            elif flux:
                if b'qt  ' in data[:32] or not 0<info['duration_ms']<=30000 or info['width']*info['height']>32000000:raise VideoError('VIDEO_REFERENCE_FORMAT','请上传有效 MP4；本站暂限 30 秒、3200 万像素。')
            elif omni:
                if not 0<info['duration_ms']<=10000:raise VideoError('VIDEO_REFERENCE_DURATION','Omni 参考视频最多 10 秒。')
            elif model not in seedance25.MODELS and (not 2000<=info['duration_ms']<=15000 or not 480<=min(info['width'],info['height'])<=720):
                raise VideoError('VIDEO_REFERENCE_FORMAT','Mini 参考视频须为 480P–720P，单段时长 2–15 秒。')
        else:
            if extension=='wav':
                with wave.open(io.BytesIO(data),'rb') as wav:
                    if wav.getcomptype()!='NONE' or not wav.getframerate() or len(wav.readframes(wav.getnframes()))!=wav.getnframes()*wav.getnchannels()*wav.getsampwidth():raise ValueError('invalid PCM WAV')
                    seconds=wav.getnframes()/wav.getframerate()
            else:
                if not(data.startswith(b'ID3') or len(data)>1 and data[0]==255 and data[1]&224==224):raise ValueError('invalid MP3')
                tag=TinyTag.get(file_obj=io.BytesIO(data));seconds=tag.duration
                if not tag.samplerate:raise ValueError('missing sample rate')
            if not seconds or not math.isfinite(seconds) or not (1 if wan else 2)<=seconds<=(30 if model in seedance25.MODELS else 15):
                raise VideoError('VIDEO_REFERENCE_DURATION','Wan 参考音频每段须为 1–15 秒。' if wan else '2.5 参考音频须为 2–30 秒。' if model in seedance25.MODELS else 'Mini 参考音频每段须为 2–15 秒，总时长最多 15 秒。')
            info={'duration_ms':round(seconds*1000)}
    except VideoError:raise
    except Exception as exc:
        raise VideoError('VIDEO_REFERENCE_FORMAT','素材内容无法识别，请使用有效的 PNG/JPG/WebP、MP4/MOV 或 MP3/PCM WAV。') from None
    result={'kind':kind,'size':len(data),'content_type':mime,**info}
    if model in seedance25.MODELS:
        seedance25.validate_references([{'id':'verified-file',**result}],{'model':model,'size':'adaptive','omni_reference_task_type':'reference'})
    return result


class VideoReferences(MusicReferences):
    def _secret(self):
        if not self.available:raise VideoError('VIDEO_REFERENCE_UNAVAILABLE','视频素材服务尚未配置。',503)
        return hashlib.sha256(('posterflow-video-reference-v1:'+self.server.SUPABASE_STORAGE_SERVICE_KEY).encode()).digest()

    @staticmethod
    def path(value):return f"posterflow/video-{value['owner']}/references/{value['id']}"

    def verify(self,token,owner,stage='verified',allow_expired=False):
        try:
            if not isinstance(token,str) or len(token)>8192:raise ValueError()
            body,signature=token.split('.')
            if not re.fullmatch(r'[A-Za-z0-9_-]+',body) or not hmac.compare_digest(signature,hmac.new(self._secret(),body.encode(),hashlib.sha256).hexdigest()):raise ValueError()
            value=json.loads(base64.urlsafe_b64decode(body+'='*(-len(body)%4)))
            if value.get('v')!=1 or value.get('stage')!=stage or value.get('owner')!=hashlib.sha256(owner.encode()).hexdigest():raise ValueError()
            if not REFERENCE_ID.fullmatch(value.get('id','')):raise ValueError()
            ext=value['id'].rsplit('.',1)[1];kind=TYPES[ext][0]
            if kind=='image' and ext not in image_formats(value.get('model')):raise ValueError()
            if value.get('kind')!=kind or type(value.get('size')) is not int or not 0<value['size']<=media_limits(value.get('model'))[kind]:raise ValueError()
            if type(value.get('issued')) is not int or value['issued']>time.time()+30 or value.get('expires')!=value['issued']+(7200 if stage=='upload' else 43200):raise ValueError()
            if stage=='verified' and not re.fullmatch(r'[a-f0-9]{64}',str(value.get('sha256',''))):raise ValueError()
        except (ValueError,TypeError,KeyError,AttributeError):
            raise VideoError('VIDEO_REFERENCE_INVALID','素材无效或不属于当前账户与服务，请重新添加。') from None
        if not allow_expired and value['expires']<=time.time()+(900 if stage=='verified' else 0):
            raise VideoError('VIDEO_REFERENCE_EXPIRED','素材已过期或临近清理，请重新添加。')
        return value

    def issue(self,owner,filename,size,content_type='',model='seedance-2.0-mini'):
        if model not in {'seedance-2.0-mini','seedance-2.0','seedance-2.0-fast',*seedance25.MODELS,'gemini-omni-1.1-flash','MiniMax-H3','MiniMax-H3-Max','wan3.0-video','flux-3-video'}:raise VideoError('INVALID_VIDEO_MODEL','该视频模型尚未接入。')
        if not isinstance(filename,str):raise VideoError('VIDEO_REFERENCE_TYPE','请选择有效文件。')
        name=re.sub(r'[\x00-\x1f\x7f]','',re.split(r'[\\/]',filename)[-1])[:120];ext=name.rsplit('.',1)[-1].lower()
        if ext not in TYPES:raise VideoError('VIDEO_REFERENCE_TYPE','支持 PNG/JPG/WebP、MP4/MOV、MP3/WAV。')
        kind,mime=TYPES[ext]
        if kind=='image' and ext not in image_formats(model):raise VideoError('VIDEO_REFERENCE_TYPE','当前模型不支持该图片格式。')
        if model=='flux-3-video' and (kind=='audio' or kind=='video' and ext!='mp4'):raise VideoError('VIDEO_REFERENCE_TYPE','FLUX 仅支持图片或 MP4。')
        if model!='wan3.0-video' and kind=='document':raise VideoError('VIDEO_REFERENCE_TYPE','当前模型不支持该素材格式。')
        if model=='gemini-omni-1.1-flash' and kind=='audio':raise VideoError('VIDEO_REFERENCE_TYPE','Omni 不支持参考音频。')
        if type(size) is not int or not 0<size<=media_limits(model)[kind]:
            if model==seedance25.FLASH_MODEL and kind=='image':raise VideoError('VIDEO_REFERENCE_SIZE','Flash 图片须小于 30 MB。')
            raise VideoError('VIDEO_REFERENCE_SIZE',f'当前模型的{dict(image="图片",video="视频",audio="音频")[kind]}素材上限 {media_limits(model)[kind]//(1024*1024)} MB。')
        now=int(time.time());value={'v':1,'stage':'upload','owner':hashlib.sha256(owner.encode()).hexdigest(),
            'id':f'{now}-{uuid.uuid4().hex}.{ext}','kind':kind,'name':name,'size':size,'issued':now,'expires':now+7200}
        if model!='seedance-2.0-mini':value['model']=model
        path=self.server._supabase_object_path(self.path(value))
        with self._request('POST','/object/upload/sign/'+path,headers={'Content-Type':'application/json','x-upsert':'false'},json={}) as response:
            url=self._safe_url(response.json().get('url'))
        return {'upload_ticket':self._token(value),'signed_url':url,'content_type':mime}

    def _verified(self,value,data):
        info=reference_metadata(data,value['id'].rsplit('.',1)[1],value.get('model','seedance-2.0-mini'))
        value.update(**info,stage='verified',expires=value['issued']+43200,sha256=hashlib.sha256(data).hexdigest())
        return {'id':value['id'],'name':value['name'],**info,'expires_at':value['expires'],'receipt':self._token(value)}

    def revalidate(self,value,model):
        kind=value['kind']
        if value['size']>media_limits(model).get(kind,0):
            raise VideoError('VIDEO_REFERENCE_SIZE','素材超出当前模型限制，请重新添加。')
        if kind=='image' and value['id'].rsplit('.',1)[-1] not in image_formats(model):
            raise VideoError('VIDEO_REFERENCE_TYPE','当前模型不支持该图片格式。')
        path=self.server._supabase_object_path(self.path(value))
        with self._request('GET','/object/authenticated/'+path,headers={'Accept':'application/octet-stream'},stream=True,_allow_missing=True) as response:
            chunks=[];size=0
            for chunk in response.iter_content(65536):
                size+=len(chunk)
                if size>value['size'] or size>media_limits(model).get(value['kind'],0):raise VideoError('VIDEO_REFERENCE_SIZE','素材超出当前模型限制，请重新添加。')
                chunks.append(chunk)
        data=b''.join(chunks)
        if size!=value['size'] or hashlib.sha256(data).hexdigest()!=value['sha256']:raise VideoError('VIDEO_REFERENCE_INVALID','素材内容已变化，请重新上传。')
        return {**value,**reference_metadata(data,value['id'].rsplit('.',1)[1],model)}

    def complete(self,owner,ticket):
        value=self.verify(ticket,owner,'upload');path=self.server._supabase_object_path(self.path(value))
        with self._request('GET','/object/authenticated/'+path,headers={'Accept':'application/octet-stream'},stream=True,_allow_missing=True) as response:
            chunks=[];size=0
            for chunk in response.iter_content(65536):
                size+=len(chunk)
                if size>value['size']:raise VideoError('VIDEO_REFERENCE_SIZE','上传后的素材大小不符，请重新添加。')
                chunks.append(chunk)
        if size!=value['size']:raise VideoError('VIDEO_REFERENCE_INVALID','素材上传未完成，请重新添加。')
        return self._verified(value,b''.join(chunks))

    def import_url(self,owner,url,filename,model='seedance-2.0-mini'):
        if model not in {'seedance-2.0-mini','seedance-2.0','seedance-2.0-fast',*seedance25.MODELS,'gemini-omni-1.1-flash','MiniMax-H3','MiniMax-H3-Max','wan3.0-video','flux-3-video'}:raise VideoError('INVALID_VIDEO_MODEL','该视频模型尚未接入。')
        if not safe_media_url(url):raise VideoError('VIDEO_REFERENCE_URL','请填写可公开读取的 HTTPS 素材链接。')
        ext=filename.rsplit('.',1)[-1].lower() if isinstance(filename,str) else ''
        if ext not in TYPES:raise VideoError('VIDEO_REFERENCE_TYPE','链接需要对应支持的素材文件名。')
        if TYPES[ext][0]=='image' and ext not in image_formats(model):raise VideoError('VIDEO_REFERENCE_TYPE','当前模型不支持该图片格式。')
        if model=='flux-3-video' and (TYPES[ext][0]=='audio' or TYPES[ext][0]=='video' and ext!='mp4'):raise VideoError('VIDEO_REFERENCE_TYPE','FLUX 仅支持图片或 MP4。')
        if model!='wan3.0-video' and TYPES[ext][0]=='document':raise VideoError('VIDEO_REFERENCE_TYPE','当前模型不支持该素材格式。')
        enable_heif(ext)
        if model=='gemini-omni-1.1-flash' and TYPES[ext][0]=='audio':raise VideoError('VIDEO_REFERENCE_TYPE','Omni 不支持参考音频，请使用图片或视频。')
        try:
            with pinned_custom_response('GET',url,{},None) as response:
                if response.status_code!=200:raise VideoError('VIDEO_REFERENCE_URL','素材链接暂不可读取，请改用上传文件。')
                chunks=[];size=0
                for chunk in response.iter_content(65536):
                    size+=len(chunk)
                    if size>media_limits(model)[TYPES[ext][0]]:raise VideoError('VIDEO_REFERENCE_SIZE','链接中的素材超出大小限制。')
                    chunks.append(chunk)
        except VideoError:raise
        except Exception:
            raise VideoError('VIDEO_REFERENCE_URL','无法安全读取该链接，请改用上传文件。') from None
        data=b''.join(chunks)
        # Generated tail frames may be JPEG even when their URL has no suffix.
        # A link's image filename is a hint; normalize to the verified format.
        if TYPES[ext][0]=='image':
            try:
                with Image.open(io.BytesIO(data)) as img:
                    ext=next(key for key,fmt in image_formats(model).items() if fmt==img.format)
                filename=filename.rsplit('.',1)[0]+'.'+ext
            except Exception:
                raise VideoError('VIDEO_REFERENCE_FORMAT','链接未返回支持的图片文件。') from None
        reference_metadata(data,ext,model)
        now=int(time.time());value={'v':1,'stage':'upload','owner':hashlib.sha256(owner.encode()).hexdigest(),
            'id':f'{now}-{uuid.uuid4().hex}.{ext}','kind':TYPES[ext][0],'name':filename[:120],'size':size,'issued':now,'expires':now+7200}
        if model!='seedance-2.0-mini':value['model']=model
        path=self.server._supabase_object_path(self.path(value))
        with self._request('PUT','/object/'+path,headers={'Content-Type':TYPES[ext][1],'x-upsert':'false'},data=data):pass
        return self._verified(value,data)
