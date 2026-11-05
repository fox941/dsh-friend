// Compatibility entry for existing companion consumers; implementation lives in qq-bridge.
import {QQController as BridgeController} from '@ai-friend/qq-bridge/channel';
import {registerQQAuthority,ownerIdentity} from './source-identity.js';
import {ownerMessage} from './evidence.js';
export {qqInbound,replyParts} from '@ai-friend/qq-bridge/channel';
export const qqAuthority=Object.freeze({register:registerQQAuthority,ownerIdentity,ownerMessage});
export class QQController extends BridgeController{constructor(options){super({...options,authority:qqAuthority});}}
