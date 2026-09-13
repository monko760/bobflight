#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Bounded Intel HEX validation for F7 bench images (legacy filename); no device access."""
import hashlib,struct,sys
from pathlib import Path

def validate(path,board='tmotor_f7_v2'):
    versions={'tmotor_f7_v2':'0.2.0-prototype-tmotorf7v2-sensor2-bl1','kakute_f7_hdv':'0.2.0-prototype-switchbench2-bl1'}
    if board not in versions:raise ValueError('Unsupported board')
    memory={};upper=0;eof=False
    for number,line in enumerate(Path(path).read_text().splitlines(),1):
        line=line.strip()
        if not line:continue
        if eof:raise ValueError('Records after EOF')
        if not line.startswith(':'):raise ValueError(f'Invalid HEX line {number}')
        record=bytes.fromhex(line[1:])
        if len(record)<5 or len(record)!=record[0]+5 or sum(record)&255:raise ValueError(f'Invalid size/checksum line {number}')
        count=record[0];address=int.from_bytes(record[1:3],'big');kind=record[3];data=record[4:-1]
        if kind==0:
            if address+count>0x10000:raise ValueError('HEX record crosses address page')
            for offset,value in enumerate(data):
                at=upper+address+offset
                if not 0x08000000<=at<0x08080000:raise ValueError('Data outside 512 KiB program window / overlaps reserved configuration')
                if at in memory:raise ValueError('Duplicate/overlapping HEX data')
                memory[at]=value
        elif kind==1:
            if count or address:raise ValueError('Invalid EOF')
            eof=True
        elif kind==4:
            if count!=2 or address:raise ValueError('Invalid extended address')
            upper=int.from_bytes(data,'big')<<16
        elif kind==5:
            if count!=4 or address:raise ValueError('Invalid entry record')
            entry=int.from_bytes(data,'big')
            if not 0x08000000<=(entry&~1)<0x08080000:raise ValueError('Entry outside flash')
        else:raise ValueError(f'Unsupported HEX record type {kind}')
    if not eof or not memory:raise ValueError('Missing EOF or empty image')
    vector=bytes(memory[a] for a in range(0x08000000,0x08000008))
    sp,reset=struct.unpack('<II',vector)
    if sp!=0x20010000 or sp%8:raise ValueError('Wrong F7 initial stack pointer')
    if not reset&1 or reset&~1 not in memory:raise ValueError('Invalid/unmapped Thumb reset vector')
    image=bytes(memory.get(a,255) for a in range(min(memory),max(memory)+1))
    for marker in [board.encode(),versions[board].encode()]:
        if marker not in image:raise ValueError('Expected target/version marker missing')
    return len(memory),max(memory)+1,hashlib.sha256(Path(path).read_bytes()).hexdigest()

if __name__=='__main__':
    try:
        board=sys.argv[2] if len(sys.argv)>2 else 'tmotor_f7_v2'
        count,end,digest=validate(sys.argv[1],board)
        print(f'PASS {board} HEX: {count} programmed bytes, end=0x{end:08x}, F7 vectors/bounds/version; SHA256={digest}')
    except (ValueError,KeyError,OSError,IndexError) as exc:
        sys.exit(f'F7 HEX rejected: {exc}')
