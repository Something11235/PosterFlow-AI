"""Single-use credit vouchers. Plaintext travels only through authenticated POST/export."""
import base64
import hashlib
import json
import os
import re
import secrets
import uuid

from cryptography.fernet import Fernet, InvalidToken
from flask import Blueprint, jsonify, request

try:
    from backend.supabase_service import SupabaseGateway, SupabaseError, is_supabase_configured
except ModuleNotFoundError:
    from supabase_service import SupabaseGateway, SupabaseError, is_supabase_configured

PACKAGES = [
    {'id':'pf20','credits':20,'price_fen':1000,'name':'10元20积分'},
    {'id':'pf70','credits':70,'price_fen':3000,'name':'30元70积分'},
    {'id':'pf120','credits':120,'price_fen':5000,'name':'50元120积分'},
    {'id':'pf200','credits':200,'price_fen':8000,'name':'80元200积分'},
    {'id':'pf260','credits':260,'price_fen':10000,'name':'100元260积分'},
]
PURCHASE_URL = 'https://wzyp.cn/shop/YG4BMC3P'
CODE = re.compile(r'^PF[A-Z2-7]{26}$')


class CreditCodeError(Exception):
    def __init__(self,code,message,status=400):
        super().__init__(message)
        self.code,self.message,self.status=code,message,status


def normalize_code(value):
    if not isinstance(value,str) or len(value)>160:
        raise CreditCodeError('CREDIT_CODE_UNAVAILABLE','兑换码无效或暂不可用，请核对购买记录。')
    code=re.sub(r'[\s-]','',value).upper()
    if not CODE.fullmatch(code):raise CreditCodeError('CREDIT_CODE_UNAVAILABLE','兑换码无效或暂不可用，请核对购买记录。')
    return code


def code_hash(value):return hashlib.sha256(value.encode('ascii')).hexdigest()


def export_cipher():
    # Existing server-only secret, purpose-separated. Key rotation affects old
    # export decryption only; SHA256 redemption proofs remain valid.
    secret=(os.getenv('SUPABASE_SERVICE_ROLE_KEY') or os.getenv('SUPABASE_SECRET_KEY') or '').strip()
    if not secret:raise CreditCodeError('CREDIT_CODES_NOT_READY','兑换码服务尚未就绪。',503)
    key=hashlib.sha256(('posterflow-credit-code-export-v1:'+secret).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def new_batch(data):
    if not isinstance(data,dict) or set(data)!={'request_id','package_id','quantity','note'}:
        raise CreditCodeError('INVALID_CREDIT_CODE_INPUT','请核对套餐、数量和批次说明。')
    try:rid=str(uuid.UUID(data['request_id']))
    except (ValueError,TypeError,AttributeError):raise CreditCodeError('INVALID_CREDIT_CODE_INPUT','批次编号无效。') from None
    package=next((p for p in PACKAGES if p['id']==data['package_id']),None)
    quantity=data['quantity'];note=data['note']
    if not package or type(quantity) is not int or not 1<=quantity<=500 or not isinstance(note,str) or len(note)>240:
        raise CreditCodeError('INVALID_CREDIT_CODE_INPUT','每批选择一个套餐，数量为 1–500 个，说明最多 240 字。')
    codes=['PF'+base64.b32encode(secrets.token_bytes(16)).decode().rstrip('=') for _ in range(quantity)]
    assert len(set(codes))==quantity
    params={'package_id':package['id'],'quantity':quantity,'note':note.strip()}
    fingerprint=hashlib.sha256(json.dumps(params,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
    return {'p_id':rid,'p_package':package['id'],'p_quantity':quantity,'p_note':note.strip(),'p_fingerprint':fingerprint,
            'p_export':export_cipher().encrypt(json.dumps(codes,separators=(',',':')).encode()).decode(),
            'p_codes':[{'hash':code_hash(c),'suffix':c[-4:]} for c in codes]}


def rpc(gateway,name,args):
    value=gateway.rpc(name,args)
    if not isinstance(value,dict) or not value.get('ok'):
        code=value.get('code') if isinstance(value,dict) else None
        messages={
            'CREDIT_CODE_UNAVAILABLE':('兑换码无效或暂不可用，请核对购买记录。',400),
            'CREDIT_CODE_RATE_LIMIT':('尝试次数过多，请 10 分钟后再试。',429),
            'CREDIT_BATCH_CONFLICT':('此批次编号已用于其他设置，请刷新批次列表核对。',409),
            'CREDIT_BATCH_NOT_FOUND':('未找到可操作的批次。',404),
            'EMAIL_UNVERIFIED':('请先完成邮箱验证后兑换。',403),
            'ACCOUNT_FROZEN':('当前账户不可用。',403),
            'ADMIN_REQUIRED':('该操作仅限管理员。',403),
            'CREDIT_CODE_ALREADY_REDEEMED':('此码已经兑换，不能作废或自动扣回积分，请结合淘宝订单处理售后。',409),
        }
        if code not in messages:raise CreditCodeError('CREDIT_CODES_NOT_READY','兑换码服务暂不可用，请稍后重试。',503)
        message,status=messages[code];raise CreditCodeError(code,message,status)
    return value


def create_credit_code_blueprint(require_user,require_admin,rate_limit,allowed_origins,error_response):
    bp=Blueprint('credit_codes',__name__,url_prefix='/api/credit-codes')

    @bp.after_request
    def private(response):
        response.headers['Cache-Control']='private, no-store'
        response.headers['Vary']='Authorization, Cookie'
        response.headers['X-Content-Type-Options']='nosniff'
        return response

    @bp.errorhandler(CreditCodeError)
    def error(e):return jsonify(code=e.code,error=e.message),e.status

    @bp.errorhandler(SupabaseError)
    def database_error(_e):return jsonify(code='CREDIT_CODES_NOT_READY',error='兑换码服务尚未就绪，请稍后重试。'),503

    @bp.errorhandler(Exception)
    def unexpected(e):
        if hasattr(e,'code') and hasattr(e,'status'):return error_response(e)
        return jsonify(code='CREDIT_CODES_NOT_READY',error='兑换结果暂未确认，请刷新账户后再核对原兑换码。'),503

    def origin():
        value=request.headers.get('Origin')
        if value and value.rstrip('/') not in {request.host_url.rstrip('/'),*allowed_origins}:
            raise CreditCodeError('CREDIT_CODE_ORIGIN','请求来源不受支持。',403)

    def body():
        if request.content_length and request.content_length>4096:raise CreditCodeError('INVALID_CREDIT_CODE_INPUT','请求内容过长。')
        data=request.get_json(silent=True)
        if not isinstance(data,dict):raise CreditCodeError('INVALID_CREDIT_CODE_INPUT','请求参数无效。')
        return data

    def batch_id(value):
        try:return str(uuid.UUID(value))
        except (ValueError,TypeError,AttributeError):raise CreditCodeError('CREDIT_BATCH_NOT_FOUND','未找到可操作的批次。',404) from None

    @bp.get('/config')
    def config():
        ready=False
        if is_supabase_configured():
            try:ready=bool(rpc(SupabaseGateway(),'credit_code_catalog',{}).get('ready'))
            except (CreditCodeError,SupabaseError):pass
        return jsonify(success=True,ready=ready,packages=PACKAGES,purchase_url=PURCHASE_URL,
                       purchase_available=True,automatic_taobao_verification=False,notice='在店铺选购套餐并领取本站兑换码，登录后兑换到账；购买与售后请通过店铺订单处理。')

    @bp.post('/redeem')
    def redeem():
        origin();user=require_user();rate_limit('credit-code-redeem',user.id,12,600)
        data=body()
        if set(data)!={'code'}:raise CreditCodeError('INVALID_CREDIT_CODE_INPUT','只需提交兑换码。')
        # Even malformed attempts count in the persistent limiter. Never store
        # the raw input or expose another user's redemption/account information.
        try:proof=code_hash(normalize_code(data['code']))
        except CreditCodeError:proof=''
        value=rpc(SupabaseGateway(),'redeem_credit_code',{'p_user_id':user.id,'p_hash':proof})
        return jsonify(success=True,credits=value['credits'],balance=value['balance'],idempotent=value.get('idempotent',False))

    @bp.get('/history')
    def history():
        user=require_user()
        value=rpc(SupabaseGateway(),'credit_code_history',{'p_user_id':user.id})
        return jsonify(success=True,entries=value['entries'])

    @bp.route('/admin/batches',methods=['GET','POST'])
    def batches():
        user,gateway=require_admin()
        if request.method=='GET':
            value=rpc(gateway,'admin_credit_code_batches',{'p_admin':user.id})
            return jsonify(success=True,**{k:v for k,v in value.items() if k!='ok'})
        origin()
        value=rpc(gateway,'create_credit_code_batch',{'p_admin':user.id,**new_batch(body())})
        return jsonify(success=True,batch=value['batch'],existing=value.get('existing',False)),200 if value.get('existing') else 201

    @bp.post('/admin/batches/<rid>/export')
    def export(rid):
        origin();user,gateway=require_admin();rate_limit('credit-code-export',user.id,30,600)
        value=rpc(gateway,'export_credit_code_batch',{'p_admin':user.id,'p_id':batch_id(rid)})
        try:
            codes=json.loads(export_cipher().decrypt(value['encrypted_export'].encode()))
            if not isinstance(codes,list) or any(not isinstance(c,str) or not CODE.fullmatch(c) for c in codes):raise ValueError()
            ready=set(value['ready_hashes']);codes=[c for c in codes if code_hash(c) in ready]
            if len(codes)!=len(ready):raise ValueError()
        except (InvalidToken,ValueError,TypeError,KeyError):
            raise CreditCodeError('CREDIT_CODE_EXPORT_UNAVAILABLE','此批次无法解密导出，请保留记录并联系站主；已发出的兑换码不受影响。',503) from None
        return jsonify(success=True,filename=f"posterflow-{value['package_id']}-{batch_id(rid)}.txt",text='\n'.join(codes),count=len(codes))

    @bp.post('/admin/batches/<rid>/void')
    def void(rid):
        origin();user,gateway=require_admin();data=body()
        if set(data)!={'reason'} or not isinstance(data['reason'],str) or not 2<=len(data['reason'].strip())<=240:
            raise CreditCodeError('INVALID_CREDIT_CODE_INPUT','请填写 2–240 字的作废原因。')
        value=rpc(gateway,'void_credit_code_batch',{'p_admin':user.id,'p_id':batch_id(rid),'p_reason':data['reason'].strip()})
        return jsonify(success=True,voided=value['voided'])

    @bp.post('/admin/cards/void')
    def void_card():
        origin();user,gateway=require_admin();data=body()
        if set(data)!={'code','reason'} or not isinstance(data['reason'],str) or not 2<=len(data['reason'].strip())<=240:
            raise CreditCodeError('INVALID_CREDIT_CODE_INPUT','请填写完整兑换码和 2–240 字的作废原因。')
        proof=code_hash(normalize_code(data['code']))
        value=rpc(gateway,'void_credit_code',{'p_admin':user.id,'p_hash':proof,'p_reason':data['reason'].strip()})
        return jsonify(success=True,voided=value['voided'])

    return bp
