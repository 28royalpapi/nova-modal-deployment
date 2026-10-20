
create or replace function public.nova_consume_managed_ai_quota(p_provider_id text,p_source text,p_source_limit integer,p_daily_global_limit integer)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog','public'
as $function$
declare
  v_role text := coalesce(auth.role(),'');
  v_day date := (now() at time zone 'UTC')::date;
  v_source_scope text; v_global_scope text; v_source_count integer; v_global_count integer;
begin
  if v_role <> 'service_role' then return jsonb_build_object('allowed',false,'reason','service_role_required'); end if;
  if p_provider_id is null or p_provider_id not in ('lovable-managed-ai','openrouter-free','openai-api','gemini-api') then return jsonb_build_object('allowed',false,'reason','provider_not_supported'); end if;
  if p_source is null or p_source not in ('chat','background','proactive') then return jsonb_build_object('allowed',false,'reason','invalid_source'); end if;
  if p_source_limit is null or p_daily_global_limit is null or p_source_limit<1 or p_daily_global_limit<1 or p_source_limit>p_daily_global_limit or p_daily_global_limit>1000000 then return jsonb_build_object('allowed',false,'reason','invalid_quota_configuration'); end if;
  v_global_scope:=p_provider_id||':all'; v_source_scope:=p_provider_id||':'||p_source;
  insert into public.nova_provider_usage_windows(window_start,scope,request_count,updated_at) values(v_day,v_global_scope,0,now()) on conflict(window_start,scope) do nothing;
  insert into public.nova_provider_usage_windows(window_start,scope,request_count,updated_at) values(v_day,v_source_scope,0,now()) on conflict(window_start,scope) do nothing;
  select request_count into v_global_count from public.nova_provider_usage_windows where window_start=v_day and scope=v_global_scope for update;
  select request_count into v_source_count from public.nova_provider_usage_windows where window_start=v_day and scope=v_source_scope for update;
  if v_global_count>=p_daily_global_limit or v_source_count>=p_source_limit then
    return jsonb_build_object('allowed',false,'provider_id',p_provider_id,'source',p_source,'source_count',v_source_count,'source_limit',p_source_limit,'global_count',v_global_count,'global_daily_limit',p_daily_global_limit,'resets_at',(v_day+1)::text,'reason',case when v_global_count>=p_daily_global_limit then 'provider_daily_limit' else 'source_daily_limit' end);
  end if;
  update public.nova_provider_usage_windows set request_count=request_count+1,updated_at=now() where window_start=v_day and scope=v_source_scope returning request_count into v_source_count;
  update public.nova_provider_usage_windows set request_count=request_count+1,updated_at=now() where window_start=v_day and scope=v_global_scope returning request_count into v_global_count;
  return jsonb_build_object('allowed',true,'provider_id',p_provider_id,'source',p_source,'source_count',v_source_count,'source_limit',p_source_limit,'global_count',v_global_count,'global_daily_limit',p_daily_global_limit,'resets_at',(v_day+1)::text);
end;
$function$;

create or replace function public.nova_consume_model_quota_for_user(p_user_id uuid,p_provider text)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
 v_role text:=coalesce(auth.role(),''); v_hour_start timestamptz:=date_trunc('hour',now()); v_day_start timestamptz:=date_trunc('day',now()); v_hour_count integer; v_day_count integer; v_hour_limit integer; v_day_limit integer;
begin
 if v_role<>'service_role' then return jsonb_build_object('allowed',false,'reason','service_role_required'); end if;
 if p_user_id is null then return jsonb_build_object('allowed',false,'reason','user_required'); end if;
 if p_provider is null or p_provider not in ('lovable-managed-ai','google-gemini-cli-local','openai-chatgpt-siwc-local','anthropic-claude-subscription','openai-compatible-self-hosted','openrouter-free','openai-api','gemini-api') then return jsonb_build_object('allowed',false,'reason','invalid_provider'); end if;
 if p_provider='lovable-managed-ai' then v_hour_limit:=8; v_day_limit:=20; elsif p_provider='openrouter-free' then v_hour_limit:=20; v_day_limit:=100; else v_hour_limit:=20; v_day_limit:=100; end if;
 insert into public.nova_model_usage_windows(user_id,provider_id,window_kind,window_start,request_count,updated_at) values(p_user_id,p_provider,'hour',v_hour_start,0,now()) on conflict(user_id,provider_id,window_kind,window_start) do nothing;
 insert into public.nova_model_usage_windows(user_id,provider_id,window_kind,window_start,request_count,updated_at) values(p_user_id,p_provider,'day',v_day_start,0,now()) on conflict(user_id,provider_id,window_kind,window_start) do nothing;
 select request_count into v_hour_count from public.nova_model_usage_windows where user_id=p_user_id and provider_id=p_provider and window_kind='hour' and window_start=v_hour_start for update;
 select request_count into v_day_count from public.nova_model_usage_windows where user_id=p_user_id and provider_id=p_provider and window_kind='day' and window_start=v_day_start for update;
 if v_hour_count>=v_hour_limit or v_day_count>=v_day_limit then return jsonb_build_object('allowed',false,'reason',case when v_hour_count>=v_hour_limit then 'hourly_limit' else 'daily_limit' end,'hour_count',v_hour_count,'hour_limit',v_hour_limit,'hour_resets_at',v_hour_start+interval '1 hour','day_count',v_day_count,'day_limit',v_day_limit,'day_resets_at',v_day_start+interval '1 day','provider',p_provider); end if;
 update public.nova_model_usage_windows set request_count=request_count+1,updated_at=now() where user_id=p_user_id and provider_id=p_provider and window_kind='hour' and window_start=v_hour_start returning request_count into v_hour_count;
 update public.nova_model_usage_windows set request_count=request_count+1,updated_at=now() where user_id=p_user_id and provider_id=p_provider and window_kind='day' and window_start=v_day_start returning request_count into v_day_count;
 return jsonb_build_object('allowed',true,'hour_count',v_hour_count,'hour_limit',v_hour_limit,'hour_resets_at',v_hour_start+interval '1 hour','day_count',v_day_count,'day_limit',v_day_limit,'day_resets_at',v_day_start+interval '1 day','provider',p_provider,'scope','per-user and per-provider quota');
end;
$function$;
