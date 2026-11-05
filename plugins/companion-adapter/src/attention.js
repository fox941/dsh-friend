import {SchedulerController} from '@ai-friend/attention-scheduler/controller';
import {validateAttention} from './attention-reviewer.js';
import {noSecret} from './validation.js';
// Compatibility entry for existing consumers. Production obtains the controller from the DSH service.
export class AttentionController extends SchedulerController{constructor(options){super({...options,validateDecision:validateAttention,validateData:noSecret});}}
