import { describe, expect, it } from 'vitest';
import {
  currentSingaporeRefreshKey,
  msUntilNextSingaporeRefresh,
  nextSingaporeRefreshTimeMs,
} from '@/lib/time/singapore-refresh';

describe('Singapore refresh schedule', () => {
  it('holds the previous last-close key until the New York open refresh window', () => {
    const nowMs = Date.parse('2026-03-30T12:30:00.000Z');

    expect(currentSingaporeRefreshKey(nowMs)).toBe('2026-03-27-last-close');
    expect(new Date(nextSingaporeRefreshTimeMs(nowMs)).toISOString()).toBe('2026-03-30T13:32:00.000Z');
    expect(msUntilNextSingaporeRefresh(nowMs)).toBe(62 * 60 * 1000);
  });

  it('switches into the live-open key after the New York open refresh window', () => {
    const nowMs = Date.parse('2026-03-30T13:35:00.000Z');

    expect(currentSingaporeRefreshKey(nowMs)).toBe('2026-03-30-live-open-09');
    expect(new Date(nextSingaporeRefreshTimeMs(nowMs)).toISOString()).toBe('2026-03-30T14:00:00.000Z');
  });

  it('refreshes hourly during the live-open window', () => {
    const nowMs = Date.parse('2026-03-27T14:30:00.000Z');

    expect(currentSingaporeRefreshKey(nowMs)).toBe('2026-03-27-live-open-10');
    expect(new Date(nextSingaporeRefreshTimeMs(nowMs)).toISOString()).toBe('2026-03-27T15:00:00.000Z');
  });

  it('caps live-open hourly refreshes at the last-close refresh window', () => {
    const nowMs = Date.parse('2026-03-27T20:35:00.000Z');

    expect(currentSingaporeRefreshKey(nowMs)).toBe('2026-03-27-live-open-16');
    expect(new Date(nextSingaporeRefreshTimeMs(nowMs)).toISOString()).toBe('2026-03-27T20:45:00.000Z');
  });

  it('switches into the last-close key at the single post-close refresh window', () => {
    const nowMs = Date.parse('2026-03-27T21:00:00.000Z');

    expect(currentSingaporeRefreshKey(nowMs)).toBe('2026-03-27-last-close');
    expect(new Date(nextSingaporeRefreshTimeMs(nowMs)).toISOString()).toBe('2026-03-30T13:32:00.000Z');
  });

  it('holds the previous Friday key through the weekend', () => {
    const nowMs = Date.parse('2026-03-29T04:00:00.000Z');

    expect(currentSingaporeRefreshKey(nowMs)).toBe('2026-03-27-last-close');
    expect(new Date(nextSingaporeRefreshTimeMs(nowMs)).toISOString()).toBe('2026-03-30T13:32:00.000Z');
  });
});
