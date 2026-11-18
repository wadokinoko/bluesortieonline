/* 依存ゼロの極小ストア (Redux風: state + reducer + subscribe)。
 * 低頻度の状態(画面・接続・ルーム・マッチのメタ情報)だけを保持する。
 * 高頻度の機体スナップショットはここに入れず、RemotePlayers のバッファへ直接流す。 */
export function createStore(reducer, initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    dispatch(action) {
      const next = reducer(state, action);
      if (next !== state) { state = next; subs.forEach((f) => f(state, action)); }
      return action;
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}
