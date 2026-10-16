import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../ui/report.js', import.meta.url), 'utf8');
function fixture(mode = 'local') {
  const handlers = {}, calls = [], elements = {};
  for (const id of ['channel-player','report-saved','report-note','report-time','status']) {
    elements[id] = { hidden: false, value: '', addEventListener(name, fn) { this[name] = fn; } };
  }
  elements['channel-player'].contentWindow = { postMessage: data => calls.push(['post',data]) };
  const api = {
    report: async (...args)=>calls.push(['capture',...args]),
    onReportState: fn=>{handlers.request=fn;},onReportSaved:fn=>{handlers.saved=fn;},
    reportState:async value=>calls.push(['state',value]),reportNote:async(...args)=>calls.push(['note',...args]),
    blackbox:async()=>{},reportError:async()=>{},
  };
  const context = vm.createContext({ document:{getElementById:id=>elements[id]},
    window:{addEventListener:(name,fn)=>{handlers[name]=fn;}}, setTimeout:()=>1,clearTimeout(){} });
  vm.runInContext(source, context);
  context.installReports(api,()=>mode);
  const message = data => handlers.message({source:elements['channel-player'].contentWindow,origin:'null',data});
  return {handlers,calls,elements,message};
}

test('UI bridge correlates player state replies and rejects other message sources', () => {
  const f=fixture();
  f.handlers.request({requestId:'a'});
  f.handlers.message({source:{},origin:'null',data:{type:'onto:report-state-result',requestId:'a',state:{src:'wrong'}}});
  assert.equal(f.calls.filter(x=>x[0]==='state').length,0);
  f.message({type:'onto:report-state-result',requestId:'a',state:{src:'right'}});
  assert.equal(f.calls.at(-1)[1].channel.src,'right');
  f.message({type:'onto:report-state-result',requestId:'a',state:{src:'duplicate'}});
  assert.equal(f.calls.filter(x=>x[0]==='state').length,1);
});

test('UI uses parent toast for unavailable player and non-channel tabs, saves a note', async () => {
  for (const mode of ['local','tv','library','ambient']) {
    const f=fixture(mode);
    f.handlers.saved({folder:'/saved',at:'2026-10-15T11:54:00Z',inPlayer:false});
    assert.equal(f.elements['report-saved'].hidden,false);
    assert.equal(f.elements['report-saved'].title,'/saved');
    f.elements['report-note'].value='broken';
    f.elements['report-saved'].submit({preventDefault(){}});
    await Promise.resolve();
    assert.deepEqual(f.calls.at(-1),['note','/saved','broken']);
    assert.equal(f.elements['report-saved'].hidden,true);
  }
});
