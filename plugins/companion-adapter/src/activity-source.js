import path from 'node:path';
const authorities=new Map(),sealed=new WeakSet(),key=value=>path.resolve(value).toLowerCase();
export function registerObservationAuthority(workspace,verify){const id=key(workspace);if(authorities.has(id))throw new Error('活动来源核验器不能重复注册');authorities.set(id,verify);return ()=>{if(authorities.get(id)===verify)authorities.delete(id);};}
export function verifyObservation(source,workspace){if(source?.kind!=='external_observation'||!authorities.get(key(workspace))?.(source))throw new Error('外部观察原件不能核实');return true;}
export function sealObservationSource(source){Object.freeze(source.origin);Object.freeze(source.context);Object.freeze(source);sealed.add(source);return source;}
export const trustedObservationSource=source=>Boolean(source&&sealed.has(source));
