import { describe, expect, it } from 'vitest';
import { draftPanel, recruitmentMessage } from '../src/components';
import { emptyDraft, formatContent, validateDraft } from '../src/domain';
import type { Draft, DraftData, Recruitment } from '../src/types';

const now = Date.parse('2026-11-05T12:00:00+09:00');
const data = (overrides: Partial<DraftData> = {}): DraftData => ({ ...emptyDraft(now), roles: [{ id: '400', name: 'FPS', mentionable: true }], gameIds: ['apex'], start: '13:00', end: '14:30', maximum: '4', ...overrides });
const panel = (payload: DraftData) => draftPanel({ id: '123', payload: JSON.stringify(payload), version: 0 } as Draft, 0, '', now);
describe('모집 입력과 일반 메시지', () => {
  it('단일 게임 / 역할 미선택 출력', () => {
    const v = validateDraft(data(), now);
    expect(formatContent('300', v.games, v.startsAt, v.endsAt, 1, v.maximum, [])).toBe('<@300>님이 모집 중에 있습니다.\n에이펙스 레전드 / 13:00 ~ 14:30 / [1/4]');
  });
  it('복수 게임 / 모드 / 복수 역할 출력', () => {
    const v = validateDraft(data({ gameIds: ['apex', 'deadlock'], modes: '에이펙스 레전드=일반 or 랭크\n데드락=빠른 or 일반' }), now);
    expect(formatContent('300', v.games, v.startsAt, v.endsAt, 1, 4, ['400', '401'])).toBe('<@300>님이 모집 중에 있습니다.\n에이펙스 레전드(일반 or 랭크), 데드락(빠른 or 일반) / 13:00 ~ 14:30 / [1/4] / <@&400>, <@&401>');
  });
  it('직접 입력 게임만으로 작성 가능', () => {
    expect(validateDraft(data({ gameIds: [], customGames: '마인크래프트(생존)' }), now).games).toEqual([{ name: '마인크래프트', mode: '생존' }]);
  });
  it.each(['24:00', '13:60', '1:00', 'ab:cd'])('잘못된 시간 %s 거부', start => {
    expect(() => validateDraft(data({ start }), now)).toThrow('HH:mm');
  });
  it.each(['지금', '지금부터', '13:00', '13:00 ~ 14:30', '14:00 - 15:00'])('시간 표기 유지 %s', timeText => {
    expect(validateDraft(data({ timeText }), now).timeLabel).toBe(timeText);
  });
  it('자정 경계와 UTC 날짜 보존', () => {
    const v = validateDraft(data({ start: '23:00', end: '01:00' }), now);
    expect(v.endsAt - v.startsAt).toBe(7200000);
    expect(new Date(v.endsAt).toISOString()).toBe('2026-11-05T16:00:00.000Z');
  });
  it('동일 시각 거부와 진행 중인 모집 허용', () => {
    expect(() => validateDraft(data({ end: '13:00' }), now)).toThrow('달라야');
    expect(validateDraft(data({ start: '11:00' }), now).timeLabel).toBe('11:00 ~ 14:30');
  });
  it.each(['0', '-1', '1.5', '1000', 'abc'])('잘못된 인원 %s 거부', maximum => {
    expect(() => validateDraft(data({ maximum }), now)).toThrow('정수');
  });
  it('게임명과 설명에 멘션 삽입 거부', () => {
    expect(() => validateDraft(data({ customGames: '@everyone' }), now)).toThrow('일반 텍스트');
  });
  it('필수 입력을 마쳐야 확인 버튼 활성화', () => {
    expect(panel(emptyDraft(now)).components[0]!.components![1]!.disabled).toBe(true);
    expect(() => validateDraft(data({ roles: [] }), now)).toThrow('알릴 역할');
    expect(panel(data({ roles: [] })).components[0]!.components![1]!.disabled).toBe(true);
    expect(panel(data()).components[0]!.components![1]!.disabled).toBe(false);
    expect(panel(data({ maximum: '0' })).components[0]!.components![1]!.disabled).toBe(true);
  });
  it('정원 마감/재개와 수정 멘션 차단', () => {
    const v = validateDraft(data(), now);
    const r = { id: '123', games_json: JSON.stringify(v.games), role_ids_json: '["400"]', starts_at: v.startsAt, ends_at: v.endsAt, max_members: 4, member_count: 4, status: 'open' } as Recruitment;
    const full = recruitmentMessage(r, false, now);
    expect(full.components[0]!.components![0]!.disabled).toBe(true);
    expect(full.components[0]!.components![1]!.disabled).toBe(false);
    expect(full.allowed_mentions).toMatchObject({ parse: [], roles: [], users: [] });
    expect(recruitmentMessage({ ...r, member_count: 3 }, false, now).components[0]!.components![0]!.disabled).toBe(false);
    expect(recruitmentMessage(r, true, now).allowed_mentions.roles).toEqual(['400']);
    expect(full).not.toHaveProperty('embeds');
    expect(full).not.toHaveProperty('flags');
  });
});
