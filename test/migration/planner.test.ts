import test from 'node:test';
import assert from 'node:assert/strict';
import { planMigration, LEGACY_DEFAULTS, LEGACY_PACKAGES, mergeValues } from '../../src/migration/planner.ts';
import { MODULE_IDS, type Discovery, type ModuleId } from '../../src/migration/types.ts';
function snapshot(): Discovery {
  return {profileId:'fixture',profile:{dir:'/disposable/profile',patchPath:'/disposable/profile/cordis.patch.yml',home:'/disposable/home',installAnchor:'/disposable/dsh/package.json'},revision:'one',manifest:{},patchText:'[]',manifestText:'{}',rows:[],target:{rowId:'dsh-toolbox',moduleIds:MODULE_IDS},explicit:{},peers:{},problems:[],legacyMode:true,
    sources:MODULE_IDS.map(id=>({moduleId:id,packageName:LEGACY_PACKAGES[id],version:({context:'0.4.7',retry:'0.1.9',chime:'0.6.0',goalWait:'0.3.0'} as Record<ModuleId,string>)[id],rowId:'custom-'+id,raw:{},effective:{},disabled:false,active:false,bundleSelected:true}))};
}
test('all four current versions import exact known defaults without mutating input',()=>{
  const input=snapshot();const before=structuredClone(input);const plan=planMigration(input);
  assert.deepEqual(input,before);
  for(const decision of plan.decisions){assert.equal(decision.phase,'prepared');assert.deepEqual(decision.config,{...LEGACY_DEFAULTS[decision.moduleId],enabled:true});}
});
test('disabled sources preserve config but never imply activation',()=>{
  const input=snapshot();input.sources.forEach(source=>source.disabled=true);
  assert.ok(planMigration(input).decisions.every(d=>d.config?.enabled===false));
});
test('target explicit fields win while false zero and empty arrays survive',()=>{
  const input=snapshot();input.explicit.context={compactTool:false,retryAttempts:0,ptcModelTimeouts:{}};input.explicit.retry={errorCodes:[],providers:[],retryEmptyResponse:false};input.explicit.chime={enabled:false,volume:0,dndStart:''};input.explicit.goalWait={maxHoldMs:0,waitForSubagents:false};
  const plan=planMigration(input);
  assert.equal(plan.decisions[0].config?.compactTool,false);assert.equal(plan.decisions[0].config?.retryAttempts,0);
  assert.deepEqual(plan.decisions[1].config?.errorCodes,[]);assert.equal(plan.decisions[1].config?.retryEmptyResponse,false);
  assert.equal(plan.decisions[2].config?.volume,0);assert.equal(plan.decisions[2].enabled,false);
  assert.equal(plan.decisions[3].config?.waitForSubagents,false);
});
test('partial migration leaves absent capabilities off, fresh install on',()=>{
  const input=snapshot();input.sources=input.sources.filter(s=>s.moduleId==='retry');
  assert.equal(planMigration(input).decisions.find(d=>d.moduleId==='context')?.enabled,false);
  input.sources=[];input.legacyMode=false;
  assert.ok(planMigration(input).decisions.every(d=>d.enabled));
});
test('unknown history, duplicates, expressions and invalid values fail closed locally',()=>{
  const input=snapshot();input.sources[0].version='0.1.0';input.sources[1].effective={retryEmptyResponse:{__jsExpr:'throw new Error()'}};input.sources[2].effective={volume:2};input.sources.push({...input.sources[3]});
  assert.ok(planMigration(input).decisions.every(d=>d.phase==='conflict'));
});
test('split peers conflict only on overlapping capabilities',()=>{
  const input=snapshot();input.peers.retry=['dsh-toolbox-retry'];
  const plan=planMigration(input);assert.equal(plan.decisions[1].phase,'conflict');assert.equal(plan.decisions[0].phase,'prepared');
  input.peers={};input.moduleProblems={goalWait:['experimental startup owner']};
  assert.equal(planMigration(input).decisions[3].phase,'conflict');assert.equal(planMigration(input).decisions[0].phase,'prepared');
});
test('arrays replace and prototype mutation is refused',()=>{
  assert.deepEqual(mergeValues({a:['x']},{a:[]}),{a:[]});
  assert.throws(()=>mergeValues(JSON.parse('{"__proto__":{"polluted":true}}')),/unsafe/);
});
