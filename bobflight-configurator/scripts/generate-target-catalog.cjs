// Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
// No fallback catalog: an invalid or unavailable registry is a build failure.
const {spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
let result;
for(const python of [process.env.PYTHON,'python3','python'].filter(Boolean)){
 result=spawnSync(python,[path.join(root,'../bobflight-firmware/scripts/target_registry.py'),'list','--json'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')continue;
 break;
}
if(!result || result.error || result.status!==0)throw new Error(result?.stderr || String(result?.error || 'Python 3 unavailable'));
const data=JSON.parse(result.stdout);
if(data.schema_version!==1 || !Array.isArray(data.boards) || !Array.isArray(data.mcus))throw new Error('Invalid registry output');
const file=path.join(root,'ui/src/targets/catalog.generated.json');
const text=JSON.stringify(data,null,2)+'\n';
if(process.argv.includes('--check')){
 if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==text)throw new Error('Target catalog stale: npm run targets:generate');
}else{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
const boards = Object.fromEntries(data.boards.filter(b=>b.support!=='host-only' && data.mcus.find(m=>m.id===b.mcu)?.status==='implemented').map(b=>[b.id,data.mcus.find(m=>m.id===b.mcu).part.replace(/^STM32/,'')]));
const mapFile=path.join(root,'protocol/src/flasher/board-targets.generated.ts');
const mapText='// GENERATED from the validated target registry. SPDX-License-Identifier: Apache-2.0\nexport const GENERATED_BOARD_MCU = '+JSON.stringify(boards,null,2)+' as const;\n';
if(process.argv.includes('--check')){if(!fs.existsSync(mapFile)||fs.readFileSync(mapFile,'utf8')!==mapText)throw new Error('Protocol target map stale');}
else fs.writeFileSync(mapFile,mapText);
console.log('Target catalog matches validated firmware definitions.');
