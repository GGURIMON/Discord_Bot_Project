import { GAMES } from './config/games';
import { UserError, type DraftData, type Game } from './types';

const OFFSET = 9 * 60 * 60 * 1000;
export function seoulDate(now = Date.now()): string { return new Date(now + OFFSET).toISOString().slice(0, 10); }
export function clockTime(epoch: number): string { return new Date(epoch + OFFSET).toISOString().slice(11, 16); }
export function emptyDraft(now = Date.now()): DraftData {
  return { gameIds: [], roles: [], start: '', end: '', maximum: '', modes: '', customGames: '', date: seoulDate(now) };
}
export function textValue(value: string, limit: number): string {
  const clean = value.trim();
  if (!clean || clean.length > limit || /[\r\n<>@`*_~|\\\[\]\u0000-\u001f\u007f]/u.test(clean)) {
    throw new UserError(`게임명·설명은 ${limit}자 이내의 일반 텍스트로 입력해 주세요. 멘션이나 마크다운은 사용할 수 없습니다.`);
  }
  return clean;
}
export function gamesOf(data: DraftData): Game[] {
  const games = [...new Set(data.gameIds)].map(id => {
    const game = GAMES.find(item => item.id === id);
    if (!game) throw new UserError('게임 목록이 변경되었습니다. 게임을 다시 선택해 주세요.');
    return { name: game.name } as Game;
  });
  for (const line of data.customGames.split('\n').filter(line => line.trim())) {
    const match = line.trim().match(/^(.+?)\(([^()]*)\)$/u);
    const name = textValue(match ? match[1]! : line, 80);
    if (games.some(game => game.name === name)) throw new UserError(`게임이 중복되었습니다: ${name}`);
    games.push({ name, ...(match ? { mode: textValue(match[2]!, 100) } : {}) });
  }
  const seen = new Set<string>();
  for (const line of data.modes.split('\n').filter(line => line.trim())) {
    const split = line.indexOf('=');
    const name = line.slice(0, split).trim();
    const game = games.find(item => item.name === name);
    if (split < 1 || !game || seen.has(name)) throw new UserError('게임별 모드는 선택한 게임명=설명 형식으로 게임당 한 줄씩 입력해 주세요.');
    game.mode = textValue(line.slice(split + 1), 100);
    seen.add(name);
  }
  if (!games.length) throw new UserError('게임 이름을 입력해 주세요.');
  if (games.length > 25) throw new UserError('한 모집에는 최대 25개 게임을 입력할 수 있습니다.');
  return games;
}
export function validateDraft(data: DraftData, now = Date.now(), retainedStart?: number) {
  if (data.roleError) throw new UserError(data.roleError);
  const games = gamesOf(data);
  const timeLabel = (data.timeText ?? [data.start, data.end].filter(Boolean).join(' ~ ')).trim();
  const times = timeLabel.match(/^([01]\d|2[0-3]):([0-5]\d)(?:\s*[~–-]\s*([01]\d|2[0-3]):([0-5]\d))?$/);
  const immediate = ['지금', '지금부터'].includes(timeLabel);
  if (!immediate && !times) throw new UserError('시간은 지금, HH:mm 또는 HH:mm ~ HH:mm으로 입력해 주세요.');
  if (!/^[1-9]\d{0,2}$/.test(data.maximum)) throw new UserError('최대 인원은 1~999 사이의 정수로 입력해 주세요.');
  const onDate = (hour: string, minute: string) => Date.parse(`${seoulDate(now)}T${hour}:${minute}:00+09:00`);
  let startsAt = times ? onDate(times[1]!, times[2]!) : now;
  if (times && startsAt < now) startsAt += 86400000;
  if (retainedStart !== undefined) startsAt = retainedStart;
  let endsAt = startsAt + 86400000;
  if (times?.[3]) {
    endsAt = Date.parse(`${seoulDate(startsAt)}T${times[3]}:${times[4]}:00+09:00`);
    if (endsAt === startsAt) throw new UserError('시작과 종료 시간은 달라야 합니다.');
    if (endsAt < startsAt) endsAt += 86400000;
  }
  if (!Number.isFinite(endsAt) || endsAt <= now) throw new UserError('종료 시간이 지났습니다.');
  if (!data.roles.length) throw new UserError('알릴 역할을 하나 이상 선택해 주세요.');
  if (data.roles.length > 25) throw new UserError('역할은 최대 25개까지 선택할 수 있습니다.');
  const roles = [...new Set(data.roles.map(role => role.id))];
  if (roles.some(id => !/^\d{1,20}$/.test(id))) throw new UserError('유효하지 않은 역할입니다. 다시 선택해 주세요.');
  const maximum = Number(data.maximum);
  const body = formatContent('9'.repeat(20), games, startsAt, endsAt, maximum, maximum, roles, 'open', timeLabel);
  if (body.length > 2000) throw new UserError('모집글이 2,000자를 초과합니다. 게임이나 설명을 줄여 주세요.');
  return { games, startsAt, endsAt, maximum, roles, timeLabel };
}
export function formatContent(ownerId: string, games: Game[], start: number, end: number, count: number, max: number, roles: string[], status = 'open', timeLabel?: string | null): string {
  const prefix = status === 'completed' ? '[완료됨] ' : status === 'cancelled' ? '[취소됨] ' : status === 'ended' ? '[종료됨] ' : '';
  const heading = prefix ? `${prefix}모집자 <@${ownerId}>` : `<@${ownerId}>님이 모집 중에 있습니다.`;
  return `${heading}\n${games.map(game => `${game.name}${game.mode ? `(${game.mode})` : ''}`).join(', ')} / ${timeLabel ?? `${clockTime(start)} ~ ${clockTime(end)}`} / [${count}/${max}]${roles.length ? ` / ${roles.map(id => `<@&${id}>`).join(', ')}` : ''}`;
}
