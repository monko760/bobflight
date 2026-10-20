// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {renderToStaticMarkup} from 'react-dom/server';
import {TargetCatalog} from '../src/targets/TargetCatalog';
import {catalog,boardsForFamily,mcuForBoard} from '../src/targets/catalog';
import {BOARD_OPTIONS} from '../src/flasher/types';
import {GENERATED_BOARD_MCU} from '../../protocol/src/flasher/board-targets.generated';
assert.equal(catalog.schema_version,1);
assert.equal(boardsForFamily('F4').length,0); assert.equal(boardsForFamily('H7').length,0);
assert.equal(boardsForFamily('F7').length,3);
assert.equal(mcuForBoard('unknown'),undefined);
assert.equal(mcuForBoard('tmotor_f7_v2')?.part,'STM32F722');
assert.equal(catalog.boards.find(b=>b.id==='tmotor_f7_v2')?.capabilities.motor_output,false);
assert.equal(BOARD_OPTIONS.some(b=>b.boardId==='dummy'),false);
assert.deepEqual(BOARD_OPTIONS.filter(b=>!b.imageProfile).map(b=>b.boardId).sort(),Object.keys(GENERATED_BOARD_MCU).sort());
assert(catalog.mcus.filter(m=>m.family!=='F7').every(m=>m.status==='planned'&&!m.toolchain));
const html=renderToStaticMarkup(<TargetCatalog/>);
assert(html.includes('informational'));assert(html.includes('not hardware or flight qualification'));
assert(!html.includes('<button')); assert(!html.includes('href='));
console.log('PASS target catalog: data consistency, planned/host exclusions, capability distinctions and real render');

// Supplement the rendered catalog with the actual flash-page safety integration contract.
const page=readFileSync(new URL('../src/pages/FlasherPage.tsx',import.meta.url),'utf8');
assert(page.includes('useState<BoardId>("")'));
assert(!page.includes('?? BOARD_OPTIONS[0]'));
assert(page.includes('if (!board || !flasher || !parsed || !propsOff || !backupTaken) return;'));
assert(page.includes('const canFlashLive =\n    !!board &&'));
assert(page.includes('const canFlashMock =\n    !!board &&'));
console.log('PASS explicit selection: empty initial target, no first-board fallback, live/mock/action guards');

assert.deepEqual(BOARD_OPTIONS.filter(b=>b.imageProfile).map(b=>b.boardId).sort(),['custom_f405xg_usb','mltempf4']);
assert(BOARD_OPTIONS.filter(b=>b.imageProfile).every(b=>b.mcu==='F405'&&!b.motorOutput));
// Migration equivalence (main 5bea523): option list generated from boards/<board_id>.yaml.
assert.deepEqual(BOARD_OPTIONS.filter(b=>b.imageProfile),[
  {boardId:'mltempf4', label:'Motolab Tempest F4 / MLTEMPF4 USB diagnostic', mcu:'F405', mcuDisplay:'STM32F405xG', support:'diagnostic only', motorOutput:false, primary:false, imageProfile:'f405-usb-diagnostic'},
  {boardId:'custom_f405xg_usb', label:'Custom / unknown board (basic bring-up)', mcu:'F405', mcuDisplay:'STM32F405xG', support:'USB-only reference profile', motorOutput:false, primary:false, imageProfile:'f405-usb-diagnostic'},
]);
assert.deepEqual(BOARD_OPTIONS.filter(b=>!b.imageProfile).map(b=>[b.boardId,b.label,b.mcu,b.support,b.motorOutput]),[
  ['kakute_f7_hdv','Kakute F7 HDV','F745','development',true],['matek_f722_px','Matek F722-PX','F722','development',true],['tmotor_f7_v2','T-Motor F7 V2','F722','sensor-only',false]]);
console.log('PASS board options match main 5bea523 and come only from board definitions');

// buildableBoard: build_label (K5a), implemented MCU (K5b) and main's F7-family guard.
import {buildableBoard,customProfile} from '../src/targets/catalog';
import {customProfileProblem} from '../src/flasher/DiagnosticProfileControls';
import {mcuHintFromFilename,boardNameHints} from '../src/flasher/intelHex';
{
  const mcus=[{id:'f7',family:'F7',status:'implemented'},{id:'f7p',family:'F7',status:'planned'},{id:'f4',family:'F4',status:'implemented'}];
  const b=(id:string,mcu:string,build_label:string|null,support='development')=>({id,mcu,support,build_label});
  const cat={mcus,boards:[b('ok','f7','L'),b('nolabel','f7',null),b('emptylabel','f7',''),b('planned','f7p','L'),b('f4main','f4','L'),b('host','f7','L','host-only')]};
  assert.equal(buildableBoard('ok',cat)?.id,'ok');
  for(const id of ['nolabel','emptylabel','planned','f4main','host','missing'])assert.equal(buildableBoard(id,cat),undefined,id);
  for(const id of ['kakute_f7_hdv','matek_f722_px','tmotor_f7_v2'])assert.equal(buildableBoard(id)?.id,id);
  assert.equal(buildableBoard('dummy'),undefined);assert.equal(buildableBoard('mltempf4'),undefined);
  console.log('PASS buildableBoard: needs build_label, implemented MCU, F7 family (main 5bea523 guard), not host-only');
}
{
  // Custom-profile identity and limits come from the YAML via the catalog, not from string ids.
  assert.deepEqual(customProfile('custom_f405xg_usb'),{mcu:'STM32F405',flash_kib:1024,hse_hz:8000000});
  assert.equal(customProfile('mltempf4'),undefined);assert.equal(customProfile('kakute_f7_hdv'),undefined);
  assert.equal(customProfileProblem(true,'STM32F405','1024','8000000'),null);
  assert.match(customProfileProblem(true,'STM32F411','1024','8000000')!,/not implemented here for STM32F411/);
  assert.match(customProfileProblem(true,'STM32F405','512','8000000')!,/requires STM32F405xG, 1024 KiB flash and an 8 MHz/);
  const alt={mcu:'STM32F722',flash_kib:512,hse_hz:12000000};
  assert.equal(customProfileProblem(true,'STM32F722','512','12000000',alt),null);
  assert.match(customProfileProblem(true,'STM32F405','1024','8000000',alt)!,/not implemented/);
  assert.match(customProfileProblem(true,'STM32F722','512','8000000',alt)!,/512 KiB flash and an 12 MHz/);
  assert.match(customProfileProblem(true,'STM32F405','1024','8000000',null)!,/not implemented/);
  console.log('PASS custom profile limits come from the catalog');
}
{
  assert.deepEqual(boardNameHints(),[['kakute','F745'],['matek','F722'],['tmotor','F722']]);
  assert.equal(mcuHintFromFilename('Kakute-build.hex'),'F745');assert.equal(mcuHintFromFilename('tmotor.hex'),'F722');
  assert.equal(mcuHintFromFilename('bobflight-stm32f745.hex'),'F745');assert.equal(mcuHintFromFilename('dummy.hex'),undefined);
  assert.equal(mcuHintFromFilename('random.hex'),undefined);
  console.log('PASS filename hints derived from the catalog');
}
