import assert from 'node:assert/strict';

/** Synthetic authority projection; no live Team receives these messages. */
export function messageFixture() {
 const at=Date.parse('2026-01-01T12:00:00Z');
 return {availability:'available',source:'durable:synthetic-store',epoch:'epoch-one',limits:{alerts:30,deliveries:60,events:80},records:[
  {kind:'alert',id:'a1',at,from:'team-lead',to:['builder','builder-two'],alertKind:'announcement',status:'accepted',text:'Review 日本語 '+ 'long detail '.repeat(60)+'END-OF-ALERT'},
  {kind:'alert',id:'a2',at,from:'builder-two',to:['builder-two'],alertKind:'attention',status:'accepted',text:'Second builder report'},
  {kind:'alert',id:'a3',at,from:'builder',to:['builder-two'],alertKind:'attention',status:'accepted',text:'First builder report'},
  {kind:'delivery',id:'d1',at,from:'team-lead',to:['builder'],deliveryKind:'alert',ref:'a1',status:'accepted',conversationId:'2',generation:1,acceptedAt:at},
  {kind:'delivery',id:'d2',at,from:'team-lead',to:['builder-two'],deliveryKind:'alert',ref:'a1',status:'submitted',conversationId:'3',generation:1,acceptedAt:at,submittedAt:at+1,submissionId:'s1'},
  {kind:'lead-update',id:'e1',at,from:'activity-only',to:['team-lead'],eventKind:'task_transitioned',text:'Task evidence',status:'recorded'},
 ]};
}

/** One class-level detector shared by the focused browser test and verify-ampi T3tm. */
export async function checkMessageFilters(page) {
 await page.getByRole('button',{name:'Messages',exact:true}).click();
 const region=page.getByRole('region',{name:'Messages',exact:true});
 const from=region.getByLabel('Message sender'),to=region.getByLabel('Message recipient');
 const rows=region.locator('[data-message-kind]');
 const activity=region.getByRole('checkbox',{name:'Show activity',exact:true});
 await from.waitFor();
 assert.equal(await rows.count(),3,'one row per authored Alert; deliveries fold under it');
 await region.getByRole('status').getByText(/3 of 3 rows/).waitFor();
 assert.equal(await activity.isChecked(),false);
 assert.equal(await from.locator('option[value="activity-only"]').count(),0);
 assert.equal(await to.locator('option[value="team-lead"]').count(),0);
 await from.selectOption('builder');
 await region.getByRole('status').getByText(/1 of 3 rows/).waitFor();
 assert.equal(await rows.count(),1,'sender filter must not include builder-two');
 await to.selectOption('builder');
 await region.getByText('No matching messages in this recent history.',{exact:true}).waitFor();
 assert.match(await region.getByRole('status').innerText(),/last 30 Alerts, 60 deliveries, 80 journal events/);
 await from.selectOption('');
 await region.getByRole('status').getByText(/1 of 3 rows/).waitFor();
 assert.equal(await rows.count(),1,'one fan-out Alert remains one row for To=builder');
 const alert=region.locator('[data-message-kind="alert"]');
 assert.equal(await alert.locator('.ptb-delivery-status').innerText(),'builder: received · builder-two: submitted');
 assert.match(await alert.locator('summary').getByText('received',{exact:true}).getAttribute('title'),/does not prove reading or action/);
 assert.doesNotMatch(await region.innerText(),/do not prove|does not prove/,'caveats live in the status tooltip');
 await alert.locator('summary').click();
 assert.match(await alert.locator('.ptb-message-body').innerText(),/END-OF-ALERT$/);
 await to.selectOption('');
 await activity.check();
 await region.getByRole('status').getByText(/4 of 4 rows/).waitFor();
 await from.selectOption('activity-only');
 await to.selectOption('team-lead');
 assert.equal(await rows.count(),1);
 await activity.uncheck();
 await region.getByRole('status').getByText(/3 of 3 rows/).waitFor();
 assert.equal(await from.inputValue(),'','hiding activity clears an activity-only sender');
 assert.equal(await to.inputValue(),'','hiding activity clears an activity-only recipient');
 assert.equal(await from.locator('option[value="activity-only"]').count(),0);
 assert.equal(await to.locator('option[value="team-lead"]').count(),0);
 return {rows:3,foldedDeliveries:2,exactSender:1,fanoutRecipient:1,activityDefault:'hidden'};
}
