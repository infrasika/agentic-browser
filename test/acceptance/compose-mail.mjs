import assert from 'node:assert/strict';
export async function verifyMail({compose,account,base,report}) {
  const ops=async(...args)=>JSON.parse(await compose('run','--rm','-T','ops',...args));
  const req=(route,{token,body}={})=>fetch(base+route,{method:body===undefined?'GET':'POST',headers:{origin:base,'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const call=async(route,options)=>{const response=await req(route,options);assert.equal(response.status,200,report.stage+': '+route);return response.json();};
  const login=async(email,password)=>(await call('/api/auth/login',{body:{email,password}})).token;
  report.stage='account_commands';
  const user={email:'operator-user@example.test',name:'Operator User',username:'operator-user',password:'Synthetic-Password-2026!'};
  assert.equal((await account('user-create',user)).status,'created');
  let token=await login(user.email,user.password);const balance=await call('/api/balance',{token});
  assert.equal(balance.tokenCredits,200000);
  assert.equal((await account('user-create',user)).status,'already_exists');
  assert.deepEqual(await call('/api/balance',{token}),balance);
  assert.equal((await req('/api/demo-admin',{token})).status,403);
  const newPassword='Synthetic-New-Password-2026!';
  await account('user-reset',{email:user.email,password:newPassword});
  assert.equal((await req('/api/user',{token})).status,401);
  token=await login(user.email,newPassword);assert.deepEqual(await call('/api/balance',{token}),balance);
  report.checks.push('native_ordinary_user_creation_is_idempotent_and_gives_initial_credits_once','operator_password_recovery_revokes_old_token_without_changing_balance');
  report.stage='smtp';assert.equal((await call('/api/config')).emailEnabled,false);
  const accepted=await ops('mail-test','--to','capture@example.test');assert.equal(accepted.accepted,true);
  await compose('restart','agent'); await compose('up','-d','--wait','agent');
  assert.equal((await call('/api/config')).emailEnabled,true);
  await call('/api/auth/requestPasswordReset',{body:{email:user.email}});
  const captured=JSON.parse(await compose('exec','-T','agent','node','-e',"fetch('http://fixture:9001').then(r=>r.text()).then(console.log)"));
  assert.ok(captured.messages.length>=2);
  const text=captured.messages.flatMap(message=>message.split(/\r\n--[^\r\n]+/).map(part=>{
    const split=part.indexOf('\r\n\r\n');if(split<0)return part;
    const headers=part.slice(0,split),content=part.slice(split+4);
    return /Content-Transfer-Encoding: base64/i.test(headers)?Buffer.from(content.replace(/\s/g,''),'base64').toString():content.replace(/=\r\n/g,'').replace(/=([0-9A-F]{2})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16)));
  })).join('\n').replace(/&#x([0-9a-f]+);/gi,(_,hex)=>String.fromCodePoint(parseInt(hex,16))).replace(/&#(\d+);/g,(_,number)=>String.fromCodePoint(Number(number))).replace(/&amp;/g,'&');
  const link=text.match(/https?:[^\s"'<>]+\/reset-password\?token=[^\s"'<>]+/g)?.at(-1);assert.ok(link); assert.equal(new URL(link).origin,base);
  const url=new URL(link),reset={userId:url.searchParams.get('userId'),token:url.searchParams.get('token'),password:'Mail-Recovered-Password-2026!',confirm_password:'Mail-Recovered-Password-2026!'};
  await call('/api/auth/resetPassword',{body:reset});assert.notEqual((await req('/api/auth/resetPassword',{body:reset})).status,200);
  assert.equal((await req('/api/user',{token})).status,401);token=await login(user.email,reset.password);
  assert.deepEqual(await call('/api/balance',{token}),balance);
  report.checks.push('verified_tls_smtp_enables_native_reset_single_use_and_revokes_old_login');
}
