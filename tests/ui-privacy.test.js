'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {PrivacyActions} = require('../ui/lib/privacy');
function fixture(choice='清理并暂停', failure='') {
  const actions=[];
  const api = new PrivacyActions({window:{
    async showWarningMessage(title,options){actions.push(['confirm',options.detail]);return choice;},
    async showInformationMessage(text){actions.push(['information',text]);}
  }},{client:{async request(op){actions.push(['broker',op]);return op==='privacyStatus'?{totalBytes:123}:{};}},
    async collector(op,arg){actions.push(['collector',op,arg]);if(op===failure)throw new Error('synthetic failure');return op==='previewPrivacyCleanup'?{previewToken:'a'.repeat(64),codexHome:'/synthetic/home',totalBytes:456,legacyBackupCount:2}:{cleared:true};},
    clearOutput(){actions.push(['clear-output']);},async refresh(){actions.push(['refresh']);},showPolicy(){}});
  return {api,actions};
}
test('cancelled privacy preview never deletes or pauses anything', async()=>{
  const {api,actions}=fixture(undefined); // explicit dismissal below
  api.vscode.window.showWarningMessage=async()=>undefined;
  assert.deepEqual(await api.clear(),{cancelled:true});
  assert.ok(!actions.some(a=>['privacyReset','clearPrivateData'].includes(a[1])));
});
test('confirmed clear binds collector token, pauses local first, and discloses retained remote/backups',async()=>{
  const {api,actions}=fixture(); const result=await api.clear();
  assert.equal(result.cleared,true);
  const clear=actions.find(a=>a[0]==='collector'&&a[1]==='clearPrivateData');
  assert.deepEqual(clear[2],{previewToken:'a'.repeat(64)});
  assert.ok(actions.findIndex(a=>a[1]==='privacyReset')<actions.indexOf(clear));
  assert.match(actions.find(a=>a[0]==='confirm')[1],/其他服务器／容器/);
  assert.match(actions.find(a=>a[0]==='confirm')[1],/2 份/);
});
test('partial remote cleanup failure stays paused and reports the exact partial outcome',async()=>{
  const {api,actions}=fixture('清理并暂停','clearPrivateData');
  await assert.rejects(api.clear(),/本机通知缓存已清理并暂停接收.*未确认清理完成/);
  assert.ok(!actions.some(a=>a[1]==='resumePrivacy'));
});
test('local-only cleanup requires no remote component and never claims remote deletion',async()=>{
  const {api,actions}=fixture(); await api.clear({localOnly:true});
  assert.ok(!actions.some(a=>a[0]==='collector'));
  assert.match(actions.find(a=>a[0]==='information')[1],/未作清理/);
});
test('only explicit resume resumes current environment before broker reception',async()=>{
  const {api,actions}=fixture();await api.resume();
  assert.ok(actions.findIndex(a=>a[1]==='resumePrivateData')<actions.findIndex(a=>a[1]==='resumePrivacy'));
});

test('collector refusal is surfaced and never resumes local reception',async()=>{
  const {api,actions}=fixture();
  api.collector=async()=>({ok:false,error:'synthetic permission refusal',paused:true});
  await assert.rejects(api.resume(),/未恢复.*synthetic permission refusal/);
  assert.ok(!actions.some(a=>a[1]==='resumePrivacy'));
  assert.ok(!actions.some(a=>a[0]==='information'));
});

test('collector cleanup error objects preserve the failure reason',async()=>{
  const {api}=fixture();const original=api.collector;
  api.collector=async(op,arg)=>op==='clearPrivateData'?{ok:false,error:'synthetic preview changed',paused:true}:original(op,arg);
  await assert.rejects(api.clear(),/未确认清理完成.*synthetic preview changed/);
});
