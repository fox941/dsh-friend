// Accept only exact platform text with identity-bound generated reply prefixes.
const id=value=>value===undefined||value===null?null:String(value);
export function matchPublicReply({raw,account,target,authoredBody,parent}){
 if(!raw||raw.invisible===true||id(raw.rpid_str??raw.rpid)!==target.platformId||id(raw.mid_str??raw.mid)!==account||id(raw.root_str??raw.root)!==target.root||id(raw.parent_str??raw.parent)!==target.parent)return null;
 const observed=raw.content?.message;if(typeof observed!=='string'||observed.length>1200)return null;
 if(observed===authoredBody)return {observedBody:observed,generatedPrefix:null};
 if(!parent||id(parent.rpid_str??parent.rpid)!==target.parent||id(parent.mid_str??parent.mid)!==target.peer||typeof parent.member?.uname!=='string')return null;
 for(const suffix of [' :',' : ']){const prefix='回复 @'+parent.member.uname+suffix;if(observed===prefix+authoredBody)return {observedBody:observed,generatedPrefix:prefix};}return null;
}
