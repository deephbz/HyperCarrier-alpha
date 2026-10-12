import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { visibleWidth } from '@earendil-works/pi-tui';
import { renderFooter } from '../src/visual-language.mjs';

const fixture = (extra={}) => ({cwd:'~/hc',branch:'main',session:'Resize check',multiplexer:true,
  model:{provider:'p',id:'m'},context:{used:10,limit:100},cost:0,...extra});
const ansiTheme={fg:(_tone,text)=>`\x1b[36m${text}\x1b[39m`,bold:text=>`\x1b[1m${text}\x1b[22m`};

test('auto preserves full content below old thresholds while each line fits',()=>{
  const s=fixture();
  for(const width of [89,60,49,26]) assert.deepEqual(renderFooter(s,width),[
    'Resize check · ~/hc (main)', 'p/m · 10%/100 ⟲— · $0.00',
  ]);
});
test('one-column overflow changes only the overflowing line',()=>{
  const s=fixture();
  assert.equal(visibleWidth(renderFooter(s,26)[0]),26);
  assert.equal(renderFooter(s,25)[0],'Resize check · hc (main)');
  assert.equal(renderFooter(s,25)[1],renderFooter(s,26)[1]);
  const longModel=fixture({model:{provider:'provider',id:'a-model-name-longer-than-the-line'}});
  assert.equal(renderFooter(longModel,30)[0],'Resize check · ~/hc (main)');
  assert.ok(visibleWidth(renderFooter(longModel,30)[1])<=30);
});
test('shorten a long path before shedding Session, then truncate Session last',()=>{
  const s=fixture({cwd:'~/very/long/checkout/path/hc'});
  assert.equal(renderFooter(s,26)[0],'Resize check · hc (main)');
  assert.equal(renderFooter(s,18)[0],'Resize check · hc');
  assert.equal(renderFooter(s,12)[0],'Resize check');
  assert.equal(renderFooter(s,8)[0],'Resize …');
  assert.equal(renderFooter(s,26)[0],'Resize check · hc (main)');
});
test('explicit tier overrides retain their composition when it fits',()=>{
  const s=fixture();
  assert.equal(renderFooter(s,120,{tier:'compact'})[0],'Resize check · hc (main)');
  assert.equal(renderFooter(s,120,{tier:'minimal'})[0],'Resize check · hc');
  assert.equal(renderFooter(s,120,{tier:'minimal'})[1],'p/m · 10%');
});
test('actual width includes wide characters and stale marker but excludes ANSI',()=>{
  const s=fixture({session:'设计审查',cwd:'~/项目/hc'});
  for(let width=0;width<=120;width++){
    const plain=renderFooter(s,width);
    const colored=renderFooter(s,width,{theme:ansiTheme,noColor:false});
    assert.deepEqual(colored.map(stripVTControlCharacters),plain);
    for(const line of colored)assert.ok(visibleWidth(line)<=width,`width ${width}`);
  }
  const full=renderFooter(s,120);
  const exact=Math.max(...full.map(visibleWidth));
  assert.deepEqual(renderFooter(s,exact),full);
  const stale=fixture({slots:new Map([['context.budget',{asOf:0,staleAfterMs:1,value:{kind:'ratio',used:10,limit:100,mode:'disarmed'}}]])});
  const lines=renderFooter(stale,120,{now:2});
  const w=Math.max(...lines.map(visibleWidth));
  assert.deepEqual(renderFooter(stale,w,{now:2}),lines);
  assert.ok(renderFooter(stale,w-1,{now:2}).every(line=>visibleWidth(line)<=w-1));
});
test('absent Session never leaves a leading separator',()=>{
  assert.equal(renderFooter(fixture({session:undefined}),60)[0],'~/hc (main)');
  assert.equal(renderFooter(fixture({session:''}),60)[0],'~/hc (main)');
});
