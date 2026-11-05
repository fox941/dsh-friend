/** Recheck durable source, current policy and bound transport after awaited work.
 * null means eligible for consideration, never a requirement to respond. */
export async function socialGate(controller, event, signal, {checkFriend = true} = {}) {
  signal?.throwIfAborted();
  const {store, channel} = controller;
  const fresh = store.event(event.id);
  if (!fresh || fresh.status !== 'queued') return {status: 'source_changed'};
  if (fresh.raw.historyRecovery && store.now().valueOf()-Date.parse(fresh.raw.historyRecovery.originalAt)>900000) return store.eventState(event.id,'expired');
  const binding = channel.binding, policy = store.policy();
  const sourceChanged = fresh.raw_hash !== event.raw_hash || fresh.account !== event.account
    || fresh.sender !== event.sender || fresh.thread_key !== event.thread_key
    || fresh.event_key !== event.event_key || fresh.body !== event.body;
  const disabled = !controller.isEnabled() || binding?.active === false || binding?.active === 0
    || event.account !== binding?.bot_qq
    || event.kind === 'group' && !policy.groups.includes(String(event.raw.group_id))
    || event.kind === 'request' && (event.raw.request_type==='friend'?!policy.friends:!policy.autonomousJoin&&!policy.groups.includes(String(event.raw.group_id)))
    || event.kind === 'friend' && (!policy.friends || event.sender === binding?.owner_qq);
  if(event.kind==='request'&&Number.isSafeInteger(event.raw.time)&&store.now().valueOf()-event.raw.time*1000>7*86400000)return store.eventState(event.id,'expired');
  if (sourceChanged || disabled) return store.eventState(event.id, 'cancelled');
  if (!channel.ready) {
    controller.defer({kind: 'event'});
    return {pending: true, notice: 'Waiting for verified QQ connection'};
  }
  if (event.kind === 'friend' && checkFriend) {
    let friends;
    try {
      friends = await controller.call('get_friend_list', {no_cache: true});
      if (!Array.isArray(friends)) throw Error('Invalid QQ friend-list response');
    } catch {
      signal?.throwIfAborted();
      const changed = await socialGate(controller, event, signal, {checkFriend: false});
      if (changed) return changed;
      // A failed lookup is unknown, not evidence that the friend was deleted.
      controller.defer({kind: 'time', at: store.now().valueOf() + 30000});
      return {pending: true, notice: 'Waiting to verify current QQ friendship'};
    }
    signal?.throwIfAborted();
    const changed = await socialGate(controller, event, signal, {checkFriend: false});
    if (changed) return changed;
    if (!friends.some(friend => String(friend?.user_id) === event.sender))
      return store.eventState(event.id, 'cancelled');
  }
  return null;
}
