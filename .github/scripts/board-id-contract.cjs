/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
 * Real firmware `version` (Kakute, Matek and T-Motor host builds) -> Configurator board-id parser.
 * The three tokens must equal the board definitions and the generated catalog. */
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {parseBoardIdentity}=require('../../bobflight-configurator/protocol/dist');
const catalog=require('../../bobflight-configurator/ui/src/targets/catalog.generated.json');
const builds=[['kakute_f7_hdv','build-contract'],['matek_f722_px','build-contract-matek'],['tmotor_f7_v2','build-contract-tmotor']];
const fixture=require('../../bobflight-configurator/ui/scripts/fixtures/version-replies.json');
for(const [board,dir] of builds){
  const exe=path.resolve(__dirname,'../../bobflight-firmware',dir,'bobflight_host');
  const r=spawnSync(exe,[],{input:'version\n',encoding:'latin1',timeout:20000});
  assert.equal(r.status,0,r.stderr);
  const id=parseBoardIdentity(r.stdout);
  // The UI cut-line tests replay this fixture; it must be the real firmware bytes.
  assert(r.stdout.includes(fixture[board]),`fixture version reply for ${board} is not the live firmware output`);
  // The board lines are written separately from the (96-byte, possibly truncated) version line,
  // so truncation can never land inside them: each is a complete CRLF line of its own.
  for(const k of ['board_id','board_target','board_mcu']) assert.match(r.stdout,new RegExp(`(^|\\r\\n)${k}: [a-z0-9_-]+\\r\\n`),`${board} ${k} line`);
  const b=catalog.boards.find(x=>x.id===board);const m=catalog.mcus.find(x=>x.id===b.mcu);
  assert.deepEqual(id.board_id,{kind:'value',token:board});
  assert.deepEqual(id.board_target,{kind:'value',token:b.mcu});
  assert.deepEqual(id.board_mcu,{kind:'value',token:m.part.toLowerCase()});
  console.log(`PASS ${board}: firmware version reports ${board} / ${b.mcu} / ${m.part.toLowerCase()} = catalog`);
}
