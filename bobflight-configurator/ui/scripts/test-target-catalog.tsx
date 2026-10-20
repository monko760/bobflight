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
