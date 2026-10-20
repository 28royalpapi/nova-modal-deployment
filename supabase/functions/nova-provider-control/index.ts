import {createClient} from "https://esm.sh/@supabase/supabase-js@2.57.4";
const H={"Content-Type":"application/json","Cache-Control":"no-store","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info","Access-Control-Allow-Methods":"POST,OPTIONS"};
const out=(d:unknown,s=200)=>new Response(JSON.stringify(d),{status:s,headers:H});
async function openRouterFreeCatalog(apiKey:string) {
 const response=await fetch("https://openrouter.ai/api/v1/models?output_modalities=text",{
  method:"GET",headers:{Authorization:"Bearer "+apiKey},signal:AbortSignal.timeout(12000)
 });
 if(!response.ok)throw new Error("OPENROUTER_CATALOG_HTTP_"+response.status);
 const payload:any=await response.json().catch(()=>null);
 if(!payload||!Array.isArray(payload.data))throw new Error("OPENROUTER_CATALOG_INVALID");
 return payload.data.filter((x:any)=>x&&typeof x.id==="string"&&x.id.endsWith(":free"))
 .slice(0,200).map((x:any)=>({
  id:x.id,name:typeof x.name==="string"?x.name.slice(0,180):x.id,
  description:typeof x.description==="string"?x.description.slice(0,400):"",
  context_length:Number.isFinite(Number(x.context_length))?Number(x.context_length):null,
  free:true,tool_calling:Array.isArray(x.supported_parameters)&&x.supported_parameters.includes("tools"),
  input_modalities:Array.isArray(x.architecture?.input_modalities)?x.architecture.input_modalities.slice(0,5):["text"],
  output_modalities:Array.isArray(x.architecture?.output_modalities)?x.architecture.output_modalities.slice(0,5):["text"]
 }));
}
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:H});if(req.method!=="POST")return out({error:"METHOD_NOT_ALLOWED"},405);
 const url=Deno.env.get("SUPABASE_URL"),anon=Deno.env.get("SUPABASE_ANON_KEY"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");const auth=req.headers.get("Authorization")||"";
 if(!url||!anon||!key)return out({error:"CONFIGURATION_MISSING"},503);
 const userClient=createClient(url,anon,{global:{headers:{Authorization:auth}},auth:{persistSession:false,autoRefreshToken:false}});const {data:who,error:ae}=await userClient.auth.getUser();if(ae||!who.user)return out({error:"AUTH_REQUIRED"},401);
 const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});const body=await req.json().catch(()=>null);if(!body||typeof body!=="object")return out({error:"INVALID_BODY"},400);const requestedAction=String(body.action||"list");
 const action=["providers.list","availability.list"].includes(requestedAction)?"list":requestedAction==="preferences.get"?"get":requestedAction;
 const model=(Deno.env.get("NOVA_LOVABLE_CHAT_MODEL")||"google/gemini-3.8-flash").trim();
  const geminiModel=(Deno.env.get("NOVA_GEMINI_CHAT_MODEL")||"gemini-3.8-flash").trim();
  const openaiModel=(Deno.env.get("NOVA_OPENAI_CHAT_MODEL")||"gpt-5-mini").trim();
 if(action==="list"||action==="get"){
  const [pref,runtime,geminiCheck,lovableCheck,openrouterCheck,openaiCheck]=await Promise.all([
   db.from("nova_model_preferences").select("provider_id,model_id,updated_at").eq("user_id",who.user.id).maybeSingle(),
   db.from("nova_local_model_runtimes").select("runtime_id,display_name,provider_ids,last_seen_at").eq("user_id",who.user.id).gte("last_seen_at",new Date(Date.now()-60000).toISOString()).limit(4),
   db.from("nova_runtime_heartbeats").select("last_succeeded_at,last_status,last_error_code,last_summary").eq("service_name","nova-provider-gemini-api").maybeSingle(),
    db.from("nova_runtime_heartbeats").select("last_succeeded_at,last_status,last_error_code,last_summary").eq("service_name","nova-provider-lovable-managed-ai").maybeSingle(),
   db.from("nova_runtime_heartbeats").select("last_succeeded_at,last_status,last_error_code,last_summary").eq("service_name","nova-provider-openrouter-free").maybeSingle(),
   db.from("nova_runtime_heartbeats").select("last_succeeded_at,last_status,last_error_code,last_summary").eq("service_name","nova-provider-openai-api").maybeSingle()
  ]);
  const geminiReady=Boolean(Deno.env.get("GEMINI_API_KEY")?.trim());
   const lovableReady=Boolean(Deno.env.get("LOVABLE_API_KEY")?.trim());
  const openrouterReady=Boolean(Deno.env.get("OPENROUTER_API_KEY")?.trim());
  const openaiReady=Boolean(Deno.env.get("OPENAI_API_KEY")?.trim());
  const verified=(row:any,configured:boolean)=>configured&&row?.last_status==="ok"&&Number.isFinite(Date.parse(row.last_succeeded_at||""))&&Date.now()-Date.parse(row.last_succeeded_at)<=15*60*1000;
  const geminiConnected=verified(geminiCheck.data,geminiReady);
   const lovableConnected=verified(lovableCheck.data,lovableReady);
  const openrouterConnected=verified(openrouterCheck.data,openrouterReady);
  const openaiConnected=verified(openaiCheck.data,openaiReady);
  let openrouterModels:any[]=[];
  let openrouterCatalogError:string|null=null;
  let catalogMode="not_configured";
  let catalogRefreshedAt:string|null=null;
  let catalogStale=false;
  if(openrouterReady){
   const nowMs=Date.now();
   const nowIso=new Date(nowMs).toISOString();
   const expiryIso=new Date(nowMs+15*60*1000).toISOString();
   const refreshStaleBefore=new Date(nowMs-30000).toISOString();
   const {error:seedError}=await db.from("nova_model_catalog_cache").upsert({
    provider_id:"openrouter-free",models:[],expires_at:new Date(0).toISOString(),updated_at:nowIso
   },{onConflict:"provider_id",ignoreDuplicates:true});
   const {data:cache,error:cacheError}=await db.from("nova_model_catalog_cache")
    .select("models,cached_at,expires_at,refresh_started_at,last_error_code")
    .eq("provider_id","openrouter-free").maybeSingle();
   if(cacheError||seedError){
    openrouterCatalogError="MODEL_CATALOG_CACHE_UNAVAILABLE";
   }else{
    const cached=Array.isArray(cache?.models)?cache.models.filter((x:any)=>x&&typeof x.id==="string"&&x.id.endsWith(":free")).slice(0,200):[];
    const expires=cache?.expires_at?Date.parse(cache.expires_at):0;
    const cachedAt=cache?.cached_at?Date.parse(cache.cached_at):0;
    catalogRefreshedAt=Number.isFinite(cachedAt)&&cachedAt>0?new Date(cachedAt).toISOString():null;
    if(Number.isFinite(expires)&&expires>nowMs){
     openrouterModels=cached;
     catalogStale=Boolean(cache?.last_error_code)||!(Number.isFinite(cachedAt)&&cachedAt>0&&nowMs-cachedAt<=15*60*1000);
     openrouterCatalogError=typeof cache?.last_error_code==="string"?cache.last_error_code:null;
     catalogMode=cached.length?(openrouterCatalogError?"stale_cache_cooldown":"shared_cache"):(openrouterCatalogError?"unavailable_cooldown":"empty_cache");
    }else{
     const {data:lease,error:leaseError}=await db.from("nova_model_catalog_cache")
      .update({refresh_started_at:nowIso,updated_at:nowIso})
      .eq("provider_id","openrouter-free")
      .or("refresh_started_at.is.null,refresh_started_at.lt."+refreshStaleBefore)
      .select("provider_id").maybeSingle();
     if(leaseError){
      openrouterCatalogError="MODEL_CATALOG_REFRESH_LEASE_FAILED";
     }else if(!lease){
      openrouterModels=cached;
      catalogMode=cached.length?"stale_cache_refresh_in_progress":"refresh_in_progress";
      catalogStale=Boolean(cached.length);
      openrouterCatalogError=typeof cache?.last_error_code==="string"?cache.last_error_code:null;
     }else{
      try{
       const refreshed=await openRouterFreeCatalog(Deno.env.get("OPENROUTER_API_KEY")!.trim());
       const persisted=await db.from("nova_model_catalog_cache").update({
        models:refreshed,cached_at:nowIso,expires_at:expiryIso,refresh_started_at:null,
        last_error_code:null,updated_at:nowIso
       }).eq("provider_id","openrouter-free").select("provider_id").maybeSingle();
       openrouterModels=refreshed;
       catalogMode=persisted.error?"refreshed_cache_write_failed":"refreshed";
       catalogRefreshedAt=nowIso;
       catalogStale=false;
       if(persisted.error)openrouterCatalogError="MODEL_CATALOG_CACHE_WRITE_FAILED";
      }catch(e){
       openrouterCatalogError="OPENROUTER_CATALOG_REFRESH_FAILED";
       await db.from("nova_model_catalog_cache").update({
        expires_at:new Date(nowMs+60000).toISOString(),refresh_started_at:null,
        last_error_code:openrouterCatalogError,updated_at:nowIso
       }).eq("provider_id","openrouter-free");
       openrouterModels=cached;
       catalogMode=cached.length?"stale_cache_fallback":"unavailable";
       catalogStale=Boolean(cached.length);
      }
     }
    }
   }
  }
  const catalog=[{id:"openrouter/free",name:"OpenRouter free model router",description:"Automatically routes to a provider's free models and filters for required features such as tool calling. Upstream limits apply.",free:true,tool_calling:true},...openrouterModels];
  const defaultSelection=geminiReady
     ? {provider_id:"gemini-api",model_id:geminiModel}
     : openaiReady
       ? {provider_id:"openai-api",model_id:openaiModel}
       : openrouterReady
         ? {provider_id:"openrouter-free",model_id:"openrouter/free"}
         : {provider_id:"gemini-api",model_id:geminiModel};
  return out({ok:true,selected:pref.data||defaultSelection,providers:[
    {id:"gemini-api",label:"Google Gemini API",available:geminiReady,connected:geminiConnected,model:geminiModel,default_model:geminiModel,models:[{id:geminiModel,label:"Gemini default"}],cost_note:"Uses the Google AI Studio Gemini API key and its account-specific quotas.",disabled_reason:!geminiReady?"Set GEMINI_API_KEY as a server-side Supabase Edge Function secret.":!geminiConnected?"Run a successful provider test before selecting this route.":null,reason:!geminiReady?"GEMINI_API_KEY is not configured on this Supabase project.":!geminiConnected?(geminiCheck.data?.last_error_code||"Provider inference has not yet been verified."):"A successful Gemini inference test completed within the last 15 minutes."},
    {id:"openai-api",label:"OpenAI API",available:openaiReady,connected:openaiConnected,model:openaiModel,default_model:openaiModel,models:[{id:openaiModel,label:"OpenAI default"}],cost_note:"Uses your OpenAI API project billing. Set a budget and usage limits in the OpenAI Platform.",disabled_reason:!openaiReady?"Set OPENAI_API_KEY as a server-side Supabase Edge Function secret.":!openaiConnected?"Run a successful provider test before selecting this route.":null,reason:!openaiReady?"OPENAI_API_KEY is not configured on this Supabase project.":!openaiConnected?(openaiCheck.data?.last_error_code||"Provider inference has not yet been verified."):"A successful OpenAI inference test completed within the last 15 minutes."},
   {id:"lovable-managed-ai",label:"NOVA Managed AI (Lovable)",available:lovableReady,connected:lovableConnected,model,default_model:model,models:[{id:model,label:"Managed default"}],cost_note:"Uses NOVA's managed AI allowance and usage limits.",disabled_reason:!lovableReady?"LOVABLE_API_KEY must be configured on the Supabase project.":!lovableConnected?"Run a successful provider test before selecting this route.":null,reason:!lovableReady?"LOVABLE_API_KEY must be configured on this Supabase project.":!lovableConnected?(lovableCheck.data?.last_error_code||"Provider inference has not yet been verified."):"A successful inference test completed within the last 15 minutes."},
   {id:"openrouter-free",label:"Free models (OpenRouter)",available:openrouterReady,connected:openrouterConnected,model:"openrouter/free",default_model:"openrouter/free",models:catalog.map((x:any)=>({id:x.id,label:x.name||x.id,free:true,context_length:x.context_length??null,tool_calling:Boolean(x.tool_calling)})),catalog_count:openrouterModels.length,catalog_error:openrouterCatalogError,catalog_mode:catalogMode,catalog_stale:catalogStale,catalog_refreshed_at:catalogRefreshedAt,catalog_cache_ttl_seconds:900,cost_note:"Free-tagged models only; actual availability, limits, and any eligibility depend on OpenRouter/upstream providers.",disabled_reason:!openrouterReady?"Set OPENROUTER_API_KEY as a server-side Supabase Edge Function secret.":!openrouterConnected?"Run a successful provider test before selecting this route.":null,reason:!openrouterReady?"Set OPENROUTER_API_KEY on the Supabase project to enable this provider":openrouterCatalogError||(!openrouterModels.length?"No free text models returned by provider":!openrouterConnected?(openrouterCheck.data?.last_error_code||"Provider inference has not yet been verified."):"Live free-model catalog loaded; provider inference is verified.")},
  ],runtimes:runtime.data||[]});
 }
 if(action==="test"){
  const p=String(body.provider_id||"gemini-api");const m=String(body.model_id||(p==="gemini-api"?geminiModel:p==="openrouter-free"?"openrouter/free":p==="openai-api"?openaiModel:model));
  if(!["gemini-api","openai-api","lovable-managed-ai","openrouter-free"].includes(p))return out({error:"PROVIDER_TEST_NOT_SUPPORTED"},400);
  if(p==="lovable-managed-ai"&&m!==model)return out({error:"MODEL_NOT_ALLOWED"},400);
  if(p==="gemini-api"&&m!==geminiModel)return out({error:"MODEL_NOT_ALLOWED"},400);
   if(p==="openai-api"&&m!==openaiModel)return out({error:"MODEL_NOT_ALLOWED"},400);
  if(p==="openrouter-free"){
   const k=Deno.env.get("OPENROUTER_API_KEY")?.trim()||"";
   if(!k)return out({error:"OPENROUTER_NOT_CONFIGURED"},503);
   if(m!=="openrouter/free"){let models:any[];try{models=await openRouterFreeCatalog(k);}catch{return out({error:"OPENROUTER_CATALOG_UNAVAILABLE"},502);}
    if(!models.some((x:any)=>x.id===m))return out({error:"MODEL_NOT_IN_FREE_CATALOG"},400);}
  }
  const configured=p==="gemini-api"?geminiReady:p==="openai-api"?Boolean(Deno.env.get("OPENAI_API_KEY")?.trim()):p==="lovable-managed-ai"?Boolean(Deno.env.get("LOVABLE_API_KEY")?.trim()):Boolean(Deno.env.get("OPENROUTER_API_KEY")?.trim());
   if(!configured)return out({error:p==="gemini-api"?"GEMINI_API_KEY_NOT_CONFIGURED":p==="openai-api"?"OPENAI_API_KEY_NOT_CONFIGURED":p==="lovable-managed-ai"?"LOVABLE_AI_NOT_CONFIGURED":"OPENROUTER_NOT_CONFIGURED",required_secret:p==="gemini-api"?"GEMINI_API_KEY":p==="openai-api"?"OPENAI_API_KEY":undefined},503);
  const started=new Date().toISOString();
  let status=502,errorCode="PROVIDER_TEST_UNREACHABLE",valid=false;
  try{
   const response=await fetch(url+"/functions/v1/nova-model-proxy",{method:"POST",headers:{Authorization:auth,"Content-Type":"application/json"},body:JSON.stringify({provider_id:p,model_id:m,messages:[{role:"user",content:"Reply with exactly NOVA_PROVIDER_CHECK_OK."}],max_tokens:24,temperature:0}),signal:AbortSignal.timeout(35000)});
   status=response.status;
   const data=await response.json().catch(()=>null);
   valid=response.ok&&data?.ok===true&&Array.isArray(data?.choices)&&typeof data?.choices?.[0]?.message?.content==="string"&&data.choices[0].message.content.trim().length>0;
   errorCode=valid?"":typeof data?.error==="string"?data.error.slice(0,120):"PROVIDER_TEST_INVALID_RESPONSE";
  }catch{errorCode="PROVIDER_TEST_UNREACHABLE";}
  const {error:saveError}=await db.from("nova_runtime_heartbeats").upsert({
   service_name:"nova-provider-"+p,last_started_at:started,last_succeeded_at:valid?started:null,last_failed_at:valid?null:started,
   last_status:valid?"ok":"failed",last_error_code:valid?null:errorCode,
   last_summary:{provider_id:p,model_id:m,response_status:status,inference_verified:valid},updated_at:started
  },{onConflict:"service_name"});
  if(saveError)return out({error:"PROVIDER_TEST_STATUS_SAVE_FAILED"},503);
  if(!valid)return out({ok:false,error:"PROVIDER_TEST_FAILED",provider_id:p,status_code:status,provider_error:errorCode},status===429?429:status===503?503:502);
  return out({ok:true,provider_id:p,model_id:m,verified_at:started,valid_for_seconds:900});
 }
 if(action==="set"){
  const p=String(body.provider_id||"");const m=String(body.model_id||"auto");
  if(!["gemini-api","openai-api","lovable-managed-ai","openrouter-free"].includes(p))return out({error:"PROVIDER_NOT_ALLOWED"},400);
  if(p==="lovable-managed-ai"&&m!==model)return out({error:"MODEL_NOT_ALLOWED"},400);
  if(p==="gemini-api"&&m!==geminiModel)return out({error:"MODEL_NOT_ALLOWED"},400);
   if(p==="openai-api"&&m!==openaiModel)return out({error:"MODEL_NOT_ALLOWED"},400);
  if(p==="gemini-api"&&!Deno.env.get("GEMINI_API_KEY")?.trim())return out({error:"GEMINI_API_KEY_NOT_CONFIGURED",required_secret:"GEMINI_API_KEY"},409);
   if(p==="openai-api"&&!Deno.env.get("OPENAI_API_KEY")?.trim())return out({error:"OPENAI_API_KEY_NOT_CONFIGURED",required_secret:"OPENAI_API_KEY"},409);
  if(p==="openrouter-free"){
   const k=Deno.env.get("OPENROUTER_API_KEY")?.trim()||"";
   if(!k)return out({error:"OPENROUTER_NOT_CONFIGURED",required_secret:"OPENROUTER_API_KEY"},409);
   if(m!=="openrouter/free"){let models:any[];try{models=await openRouterFreeCatalog(k);}catch{return out({error:"OPENROUTER_CATALOG_UNAVAILABLE"},502);}
    if(!models.some((x:any)=>x.id===m))return out({error:"MODEL_NOT_IN_FREE_CATALOG"},400);}
  }
  if(p==="gemini-api"||p==="openai-api"||p==="lovable-managed-ai"||p==="openrouter-free"){
   const {data:check,error:checkError}=await db.from("nova_runtime_heartbeats").select("last_succeeded_at,last_status,last_summary").eq("service_name","nova-provider-"+p).maybeSingle();
   const last=check?.last_succeeded_at?Date.parse(check.last_succeeded_at):0;
   if(checkError)return out({error:"PROVIDER_VERIFICATION_LOOKUP_FAILED"},503);
   if(check?.last_status!=="ok"||!Number.isFinite(last)||Date.now()-last>15*60*1000)return out({error:"PROVIDER_NOT_VERIFIED",required_action:"test"},409);
   const testedModel=check?.last_summary&&typeof check.last_summary==="object"?(check.last_summary as Record<string,unknown>).model_id:null;
   if(testedModel!==m)return out({error:"SELECTED_MODEL_NOT_VERIFIED",required_action:"test",tested_model:typeof testedModel==="string"?testedModel:null,selected_model:m},409);
  }
  const {error}=await db.from("nova_model_preferences").upsert({user_id:who.user.id,provider_id:p,model_id:m,updated_at:new Date().toISOString()},{onConflict:"user_id"});if(error)return out({error:"PREFERENCE_WRITE_FAILED"},503);return out({ok:true,provider_id:p,model_id:m});
 }
 return out({error:"UNKNOWN_ACTION",supported:["list","get","test","set"]},400);
});