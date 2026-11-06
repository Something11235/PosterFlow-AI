// Local submission attempts must not masquerade as accepted server jobs.
export function videoJobTitle(job,models=[]){
  if(job.operation==='asset_review')return '素材审核';
  const name=models.find(m=>m.id===job.model)?.name || job.model || '视频任务';
  return `${name}${job.is_draft?' 样片':''}${job.resolution?` · ${String(job.resolution).toUpperCase()}`:''}`;
}

export function videoSubmissionFailure(placeholder,error){
  const unknown=error.submission_unknown ?? (!error.status || error.status>=500);
  const notSubmitted=!unknown && ['validation','reservation'].includes(error.submission_phase);
  return {...placeholder,status:unknown?'submission_unknown':notSubmitted?'not_submitted':'failed',
    error_code:error.code,failure_reason:error.message || '视频请求暂未确认，请保留原编号核对。',
    submission_phase:error.submission_phase};
}

export function mergeVideoJobs(previous,next){
  const jobs=new Map(previous.map(j=>[j.request_id,j]));
  for(const job of next){
    const before=jobs.get(job.request_id);
    // A late POST error must not overwrite a job recovered from the server.
    if(before && !before.local_attempt && job.local_attempt)continue;
    jobs.set(job.request_id,job);
  }
  return [...jobs.values()].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,50);
}
