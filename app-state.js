/* BLUE SORTIE ONLINE アプリ状態
 *
 *  screen : 'title' | 'menu' | 'lobby' | 'friend' | 'room' | 'settings' | 'missions' | 'game'
 *  conn   : { status:'offline'|'connecting'|'online'|'reconnecting'|'error', ping, error, mock }
 *  room   : サーバーが配信する RoomState (null = ルーム外)
 *  match  : { matchId, seed, settings, players:[pid], startedAt } | null   (対戦中のみ)
 *
 * 状態遷移の入口はすべて dispatch(action)。サーバー由来の更新は NetClient が action に変換する。 */

export const initialState = (profile, settings, mock) => ({
  screen: 'title',
  profile,
  settings,
  conn: { status: 'offline', ping: null, error: null, mock: !!mock },
  room: null,
  match: null,
  toast: null,
});

export function reducer(s, a) {
  switch (a.type) {
    case 'nav': return s.screen === a.screen ? s : { ...s, screen: a.screen };
    case 'profile': return { ...s, profile: { ...s.profile, ...a.patch } };
    case 'settings': return { ...s, settings: { ...s.settings, ...a.patch } };
    case 'conn': return { ...s, conn: { ...s.conn, ...a.patch } };
    case 'room/set': {
      // 古い rev は破棄(順序入れ替わり対策)
      if (s.room && s.room.code === a.room.code && a.room.rev < s.room.rev) return s;
      return { ...s, room: a.room };
    }
    case 'room/clear': return { ...s, room: null, match: null };
    case 'match/start': return { ...s, match: a.match };
    case 'match/end': return { ...s, match: null };
    case 'toast': return { ...s, toast: { msg: a.msg, kind: a.kind || 'info', id: (s.toast ? s.toast.id : 0) + 1 } };
    default: return s;
  }
}

/* ---- セレクタ ---- */
export const selfPlayer = (s) => (s.room ? s.room.players.find((p) => p.id === s.profile.id) || null : null);
export const isHost = (s) => !!s.room && s.room.hostId === s.profile.id;
export const slotOf = (s) => (s.room ? s.room.players.findIndex((p) => p.id === s.profile.id) : -1);
export function canStart(s) {
  if (!s.room || !isHost(s) || s.room.status !== 'lobby') return { ok: false, why: '' };
  const pl = s.room.players.filter((p) => p.connected !== false);
  if (pl.length < 2) return { ok: false, why: '2人以上で開始できます' };
  if (!pl.every((p) => p.id === s.room.hostId || p.ready)) return { ok: false, why: '全員の準備完了を待っています' };
  return { ok: true, why: '' };
}
