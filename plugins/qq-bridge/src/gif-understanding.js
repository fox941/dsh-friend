/** Validate each frame against actual attachment indices. Times are always
 * supplied by decoding metadata, never accepted from a model's invented PTS. */
export function gifUnderstanding(item,image){
 if(image.mediaType!=='image/gif')return undefined;const frames=image.frames??[];if(!frames.length)return undefined;
 if(frames.length===1)return {frameObservations:[{attachmentIndex:frames[0].attachmentIndex,timeSeconds:frames[0].timeSeconds,description:item.description}],changes:'本次只有一个采样帧，不能据此判断动作变化',certainty:'uncertain',sampledOnly:true};
 const value=item.temporal;if(!value||!Array.isArray(value.frameObservations)||value.frameObservations.length!==frames.length||typeof value.changes!=='string'||!value.changes.trim()||value.changes.length>500||!['clear','subtle','uncertain'].includes(value.certainty))return undefined;
 const seen=new Set();for(const f of value.frameObservations){if(!Number.isInteger(f?.attachmentIndex)||seen.has(f.attachmentIndex)||!frames.some(i=>i.attachmentIndex===f.attachmentIndex)||typeof f.description!=='string'||!f.description.trim()||f.description.length>240)return undefined;seen.add(f.attachmentIndex);}
 return {frameObservations:frames.map(f=>({attachmentIndex:f.attachmentIndex,timeSeconds:f.timeSeconds,description:value.frameObservations.find(i=>i.attachmentIndex===f.attachmentIndex).description.trim()})),changes:value.changes.trim(),certainty:value.certainty,sampledOnly:true};
}
