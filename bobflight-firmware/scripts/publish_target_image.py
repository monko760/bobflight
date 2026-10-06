#!/usr/bin/env python3
# Copyright 2026 Robert Leclercq
# SPDX-License-Identifier: Apache-2.0
"""Validate then publish a paired HEX and provenance manifest. Never accesses a device."""
import argparse
import hashlib
import json
import os
import subprocess
import shutil
import tempfile
from pathlib import Path
from target_registry import TargetRegistry
from check_tmotor_image import validate

def publish(target, image, output):
    registry=TargetRegistry()
    resolved=registry.resolve(target, hardware=True)
    image=Path(image); output=Path(output)
    # Validate and publish the SAME snapshot, even if the input is rebuilt concurrently.
    payload=image.read_bytes()
    with tempfile.TemporaryDirectory(prefix='bobflight-image-check-') as temporary:
        snapshot=Path(temporary)/'image.hex'
        snapshot.write_bytes(payload)
        count,end,digest=validate(snapshot,target) # Unknown image policies fail closed.
    repo=registry.root.parent
    commit=subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip()
    dirty=bool(subprocess.check_output(['git','-C',str(repo),'status','--porcelain','--untracked-files=no'],text=True).strip())
    name=f'bobflight-{target}-main.hex'
    manifest={'schema_version':1,'board':resolved['board'],'mcu':resolved['mcu'],
              'file':name,'sha256':digest,'programmed_bytes':count,'program_end_exclusive':end,
              'git_commit':commit,'tracked_source_dirty':dirty,'hardware_qualified':False,
              'definition_sha256':hashlib.sha256(json.dumps(resolved,sort_keys=True).encode()).hexdigest(),
              'ir_sha256':hashlib.sha256(registry.path(resolved['ir_path']).read_bytes()).hexdigest(),
              'toolchain_sha256':hashlib.sha256(registry.path(resolved['toolchain']).read_bytes()).hexdigest()}
    manifest_bytes=(json.dumps(manifest,indent=2)+'\n').encode()
    artifact_id=hashlib.sha256(payload+manifest_bytes).hexdigest()[:20]
    parent=output/'artifacts'/target
    parent.mkdir(parents=True,exist_ok=True)
    destination=parent/artifact_id
    temporary=Path(tempfile.mkdtemp(prefix='.staging-',dir=parent))
    try:
        for filename,data in ((name,payload),(name+'.json',manifest_bytes)):
            with (temporary/filename).open('wb') as f:
                f.write(data);f.flush();os.fsync(f.fileno())
        if destination.exists():
            # Identical reruns are harmless. Never overwrite a conflicting artifact.
            if (destination/name).read_bytes()!=payload or (destination/(name+'.json')).read_bytes()!=manifest_bytes:
                raise ValueError('Artifact directory conflicts with verified contents')
        else:
            # Same-filesystem directory rename publishes the complete pair together.
            os.rename(temporary,destination)
    finally:
        if temporary.exists():shutil.rmtree(temporary)
    print(f'Validated HEX: {destination/name}\nManifest: {destination/(name+".json")}\nSHA256: {digest}')
    return {'manifest':manifest,'directory':str(destination)}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target',required=True);parser.add_argument('--hex',required=True,type=Path);parser.add_argument('--output',required=True,type=Path)
    a=parser.parse_args()
    try: publish(a.target,a.hex,a.output)
    except (ValueError,KeyError,OSError,subprocess.CalledProcessError) as e: parser.exit(1,f'Artifact rejected: {e}\n')
