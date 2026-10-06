#!/usr/bin/env python3
# Copyright 2026 Robert Leclercq
# SPDX-License-Identifier: Apache-2.0
"""Validated target metadata. No external Python dependencies or hardware probing."""
import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path, PurePosixPath

class TargetRegistryError(ValueError):
    pass

def require(ok, message):
    if not ok:
        raise TargetRegistryError(message)

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f'duplicate JSON key: {key}')
        result[key] = value
    return result

class TargetRegistry:
    def __init__(self, root=None):
        self.root = Path(root or Path(__file__).resolve().parents[1]).resolve()
        self.mcus = self.records('mcus', {'schema_version','id','family','part','core','toolchain','status'})
        self.boards = self.records('boards', {'schema_version','id','display_name','mcu','ir','support','capabilities'})
        for m in self.mcus.values():
            require(m['family'] in ('F4','F7','H7'), 'unknown MCU family')
            require(m['status'] in ('implemented','planned'), 'unknown MCU status')
            require(m['part'] == m['id'].upper() and m['part'].startswith('STM32'+m['family']), 'MCU part/family mismatch')
            require(m['core'] == ('cortex-m4' if m['family']=='F4' else 'cortex-m7'), 'MCU core mismatch')
            if m['status'] == 'implemented':
                self.path(m['toolchain'])
            else:
                require(m['toolchain'] == '', 'planned MCU must not advertise a toolchain')
        spec = importlib.util.spec_from_file_location('board_ir', self.root/'scripts/ir_codegen.py')
        self.ir = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.ir)
        for b in self.boards.values():
            require(b['mcu'] in self.mcus, 'board refers to unknown MCU')
            require(b['support'] in ('host-only','sensor-only','development'), 'unknown board support level')
            caps = b['capabilities']
            require(isinstance(caps,dict) and set(caps)=={'motor_output','usb_cdc','sd_logging'} and all(type(v) is bool for v in caps.values()), 'invalid capabilities')
            if b['support']=='host-only':
                require(not any(caps.values()), 'host-only board cannot advertise hardware capabilities')
            if b['support']=='sensor-only':
                require(not caps['motor_output'], 'sensor-only target cannot advertise motor output')
            raw = self.path(b['ir']).read_text(encoding='utf-8')
            for key in ('board_id','family'):
                require(len(re.findall(r'^\s*'+key+r':',raw,re.M))==1, f'IR requires exactly one {key}')
            info = self.ir.parse_ir(raw,b['id'])
            require(info['board_id']==b['id'], 'IR board identity mismatch')
            require(info['mcu']==self.mcus[b['mcu']]['part'], 'IR MCU mismatch')
            require((info['status'] in self.ir.PACKABLE) == (b['support']!='host-only'), 'IR status / support mismatch')

    def path(self, name):
        require(isinstance(name,str) and re.fullmatch(r'[A-Za-z0-9_./-]+',name) is not None, 'invalid relative path')
        p=PurePosixPath(name)
        require(not p.is_absolute() and '..' not in p.parts, 'path traversal refused')
        resolved=(self.root/name).resolve()
        require(self.root in resolved.parents and resolved.is_file(), 'missing file or path outside firmware tree')
        return resolved

    def records(self, directory, keys):
        files=sorted((self.root/'targets'/directory).glob('*.json'))
        require(bool(files), f'empty {directory} registry')
        result={}
        for p in files:
            require(self.root in p.resolve().parents, 'definition symlink escapes root')
            d=json.loads(p.read_text(encoding='utf-8'),object_pairs_hook=unique_object)
            require(isinstance(d,dict) and set(d)==keys, f'invalid keys: {p.name}')
            require(type(d['schema_version']) is int and d['schema_version']==1, 'unsupported schema')
            require(isinstance(d['id'],str) and re.fullmatch(r'[a-z][a-z0-9_]*',d['id']) is not None and d['id']==p.stem, 'invalid definition identity')
            require(d['id'] not in result, 'duplicate identity')
            for k,v in d.items():
                if k not in ('schema_version','capabilities'):
                    require(type(v) is str, f'{k} must be string')
            result[d['id']]=d
        return result

    def list_all(self):
        return {'schema_version':1,'mcus':list(self.mcus.values()),'boards':list(self.boards.values())}

    def resolve(self, board, hardware=False):
        require(board in self.boards, f'unknown board: {board}')
        b=self.boards[board]; m=self.mcus[b['mcu']]
        if hardware:
            require(b['support']!='host-only', 'host-only target cannot produce hardware firmware')
            require(m['status']=='implemented', f"MCU {m['id']} backend is planned, not implemented")
        return {'schema_version':1,'board':b,'mcu':m,'ir_path':b['ir'],'toolchain':m['toolchain']}

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',type=Path)
    sub=p.add_subparsers(dest='action',required=True)
    listing=sub.add_parser('list');listing.add_argument('--json',action='store_true')
    sub.add_parser('validate')
    res=sub.add_parser('resolve');res.add_argument('board');res.add_argument('--json',action='store_true');res.add_argument('--cmake',action='store_true');res.add_argument('--hardware','--require-implemented',action='store_true')
    args=p.parse_args()
    try:
        r=TargetRegistry(args.root)
        if args.action=='validate':
            print(f'PASS {len(r.mcus)} MCU definitions, {len(r.boards)} board definitions');return 0
        if args.action=='list': data=r.list_all()
        else:
            data=r.resolve(args.board,args.hardware)
            if args.cmake:
                fields={'BOBFLIGHT_IR_RELATIVE':data['ir_path'],'BOBFLIGHT_EXPECTED_MCU':data['mcu']['part'],'BOBFLIGHT_EXPECTED_TOOLCHAIN':data['toolchain'],'BOBFLIGHT_MCU_STATUS':data['mcu']['status'],'BOBFLIGHT_BOARD_SUPPORT':data['board']['support']}
                for key,val in fields.items(): print(f'set({key} "{val}")')
                return 0
        print(json.dumps(data,indent=2));return 0
    except (ValueError,OSError,ImportError,TypeError) as e:
        print(f'target registry: {e}',file=sys.stderr);return 2
if __name__=='__main__': sys.exit(main())
