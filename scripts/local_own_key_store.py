"""Development-only SQLite task store. No website accounts or credit ledger."""
import hashlib
import json
from pathlib import Path
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

from backend.apimart_image_provider import ImageTaskError


class LocalOwnKeyStore:
    database = None

    def __init__(self):
        if not self.database:
            raise RuntimeError('Local development database was not configured')
        Path(self.database).parent.mkdir(parents=True, exist_ok=True)
        with self.transaction() as db:
            db.execute('create table if not exists jobs(owner text,request_id text,fingerprint text,value text,primary key(owner,request_id))')

    @contextmanager
    def transaction(self):
        db = sqlite3.connect(self.database, timeout=10)
        try:
            db.execute('begin immediate')
            yield db
            db.commit()
        finally:
            db.close()

    def begin(self, owner, user, rid, mode, model, body, prompt):
        if mode != 'own_key':
            raise ImageTaskError('LOCAL_OWN_KEY_ONLY', '本地模式请使用自带 API Key。', 400)
        fingerprint = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        with self.transaction() as db:
            prior = db.execute('select fingerprint,value from jobs where owner=? and request_id=?', (owner, rid)).fetchone()
            if prior:
                if prior[0] != fingerprint:
                    raise ImageTaskError('IMAGE_REQUEST_CONFLICT', '请求参数不同，请查询原任务。', 409)
                return {'existing': True, 'job': json.loads(prior[1])}
            job = {'id': str(uuid.uuid4()), 'request_id': rid, 'model': model, 'billing_mode': mode,
                   'status': 'submitting', 'requested_count': body['payload']['n'], 'reference_count': len(body['references']),
                   'unit_credit_cost': 0, 'pricing_resolution': '1K', 'provider_result_urls': [], 'image_keys': [],
                   'error_code': None, 'created_at': datetime.now(timezone.utc).isoformat(), 'save_token': None, 'save_until': 0}
            db.execute('insert into jobs values(?,?,?,?)', (owner, rid, fingerprint, json.dumps(job)))
            return {'existing': False, 'job': job}

    def jobs(self, owner, request_id=None):
        with self.transaction() as db:
            if request_id:
                rows = db.execute('select value from jobs where owner=? and request_id=?', (owner, request_id)).fetchall()
            else:
                rows = db.execute('select value from jobs where owner=? order by rowid desc limit 50', (owner,)).fetchall()
            return [json.loads(row[0]) for row in rows]

    def apply(self, owner, rid, event, **kw):
        with self.transaction() as db:
            found = db.execute('select value from jobs where owner=? and request_id=?', (owner, rid)).fetchone()
            if not found:
                raise ImageTaskError('IMAGE_TASK_NOT_FOUND', '未找到本人的本地任务。', 404)
            job = json.loads(found[0])
            send = claimed = False
            if job['status'] not in ('completed', 'failed'):
                if event == 'sending' and job['status'] == 'submitting':
                    job['status'], send = 'processing', True
                elif event == 'received':
                    urls = kw['p_urls']
                    if not isinstance(urls, list) or not 1 <= len(urls) <= job['requested_count']:
                        raise ImageTaskError('INVALID_IMAGE_TASK', '结果数量无效。', 409)
                    if job['provider_result_urls'] and job['provider_result_urls'] != urls:
                        raise ImageTaskError('IMAGE_REQUEST_CONFLICT', '结果地址冲突，请核对原任务。', 409)
                    if not job['provider_result_urls']:
                        job.update(status='processing', provider_result_urls=urls)
                elif event == 'unknown' and not job['provider_result_urls']:
                    job.update(status='submission_unknown', error_code=kw.get('p_error'))
                elif event == 'failed' and not job['provider_result_urls']:
                    job.update(status='failed', error_code=kw.get('p_error'))
                elif event == 'claim' and job['provider_result_urls'] and (job['status'] != 'saving' or job['save_until'] < time.time()):
                    job.update(status='saving', save_token=kw['p_token'], save_until=time.time()+300)
                    claimed = True
                elif event in ('completed', 'retry'):
                    if job['status'] != 'saving' or kw.get('p_token') != job['save_token']:
                        raise ImageTaskError('IMAGE_SAVE_CONFLICT', '另一请求正在保存结果。', 409)
                    if event == 'completed':
                        images = kw['p_images']
                        if len(images) != len(job['provider_result_urls']):
                            raise ImageTaskError('INVALID_IMAGE_TASK', '保存结果数量尚未确认。', 409)
                        job.update(status='completed', image_keys=images, provider_result_urls=[], error_code=None)
                    else:
                        job.update(status='processing', error_code=kw.get('p_error'))
                    job.update(save_token=None, save_until=0)
                db.execute('update jobs set value=? where owner=? and request_id=?', (json.dumps(job), owner, rid))
            return {'ok': True, 'job': job, 'claimed': claimed, 'send': send}
