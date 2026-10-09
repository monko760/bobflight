/* SPDX-License-Identifier: Apache-2.0 */
// Logical QUADX positions from firmware flight/mixer.c, not an ESC wiring claim.
export const QUADX_MOTORS = [
  {number: 1, x: -90, y: 90, position: 'rear-right', front: false},
  {number: 2, x: 90, y: 90, position: 'front-right', front: true},
  {number: 3, x: -90, y: -90, position: 'rear-left', front: false},
  {number: 4, x: 90, y: -90, position: 'front-left', front: true},
] as const;

/** Body X forward, Y right, Z down. Body-to-world Rz(yaw) Ry(pitch) Rx(roll).
 * Apply yaw LAST in world coordinates, not first about the tilted body axis.
 * Positive yaw moves the nose clockwise when the board is level. */
export function aircraftProjection(roll: number, pitch: number, yaw: number) {
  const r=roll*Math.PI/180,p=pitch*Math.PI/180,h=yaw*Math.PI/180;
  const sr=Math.sin(r),cr=Math.cos(r),sp=Math.sin(p),cp=Math.cos(p),sh=Math.sin(h),ch=Math.cos(h);
  return (x: number,y: number,z=0): [number,number] => {
    const yr=y*cr-z*sr,zr=y*sr+z*cr;
    const xp=x*cp+zr*sp,zp=-x*sp+zr*cp;
    const xw=xp*ch-yr*sh,yw=xp*sh+yr*ch;
    return [240+yw*.88,160-xw*.58+zp*.7];
  };
}
