// Independent implementation. Source-review rationale and pinned upstream files:
// ../EMOTION-REFERENCES.md (ALMA, FAtiMA, feiyu-mood, EMA and EmotionML).
export const LEVELS={slight:.2,moderate:.5,strong:.8};
export const CONFIDENCE={low:.3,medium:.6,high:.9};
export const level=value=>value>=.65?'strong':value>=.3?'moderate':value>=.04?'slight':'faded';
export const levelText=value=>({strong:'明显',moderate:'中等',slight:'轻微',faded:'已淡出'})[level(value)];
export function projectEmotion(record,now,{moodMultiplier=4}={}){
  const age=Math.max(0,now-Date.parse(record.anchorAt))/60000,fast=2**(-age/record.halfLifeMinutes),slow=2**(-age/(record.halfLifeMinutes*moodMultiplier));
  // Querying is a pure projection from the committed anchor, never an update.
  let current=record.status==='active'?record.intensity*fast:0;
  let background=record.status==='retracted'?0:record.intensity*(.3+.7*(1-fast))*slow;
  if(record.status==='resolved')background*=2**(-Math.max(0,now-Date.parse(record.changedAt))/60000/record.halfLifeMinutes);
  return {current,background,level:level(current),backgroundLevel:level(background)};
}
export function emotionSummary(items){
  return items.length?items.map(row=>`${row.label}（${levelText(row.value)}；${row.reason}）`).join('；'):'当前没有达到展示门槛的已确认感受';
}
